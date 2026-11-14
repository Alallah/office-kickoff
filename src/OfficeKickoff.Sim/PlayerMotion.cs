namespace OfficeKickoff.Sim;

[Flags]
public enum MotionEvents
{
    None = 0,
    SlideStarted = 1,
    DashStarted = 2,
    DiveStarted = 4,

    /// <summary>A slide ended without touching the ball or an opponent; the slider is now stunned.</summary>
    SlideMissed = 8,

    /// <summary>The shoot button was released; <see cref="MotionResult.ReleasedCharge"/> holds the power.</summary>
    ShotReleased = 16,
}

public struct MotionResult
{
    public MotionEvents Events;

    /// <summary>0..1 charge at the moment of release (valid with <see cref="MotionEvents.ShotReleased"/>).</summary>
    public float ReleasedCharge;
}

/// <summary>
/// The movement kernel: advances ONE footballer by one tick from their input. It owns everything
/// that depends only on the footballer and their controls - aiming, the slide / dash / dive /
/// stun state machine, shot charging, stamina, acceleration and wall clamping.
///
/// It is deliberately a pure function of (player, input, hasBall, frozen, dt, tuning, pitch) and
/// knows nothing about other footballers or the ball. The browser carries a line-for-line port of
/// this file (wwwroot/js/game/predict.js) for client-side prediction: ANY change here must be
/// mirrored there.
/// </summary>
public static class PlayerMotion
{
    /// <param name="p">The footballer to advance.</param>
    /// <param name="input">Controls for this tick.</param>
    /// <param name="hasBall">True when this footballer currently owns the ball.</param>
    /// <param name="frozen">True during Intro / Kickoff countdowns: only aiming is allowed.</param>
    /// <param name="dt">Simulation seconds for this tick (already scaled by game speed / slow motion).</param>
    public static MotionResult Step(ref PlayerState p, in PlayerInput input, bool hasBall, bool frozen,
        float dt, Tuning tuning, PitchGeometry pitch)
    {
        var result = default(MotionResult);
        var pt = tuning.Player;
        var tk = tuning.Tackle;

        // 1. Aim follows the cursor unless the footballer is committed to an action.
        if (p.Action == PlayerAction.None || p.Action == PlayerAction.Dash)
        {
            var toAim = input.AimPoint - p.Pos;
            if (toAim.LengthSq > 1f) p.Aim = toAim.Angle;
        }

        if (frozen)
        {
            p.Vel = Vec2.Zero;
            p.Charging = false;
            p.Charge = 0f;
            p.Sprinting = false;
            return result;
        }

        // 2. Timers.
        p.TackleCooldown = MathF.Max(0f, p.TackleCooldown - dt);
        p.KickCooldown = MathF.Max(0f, p.KickCooldown - dt);
        p.StealLockout = MathF.Max(0f, p.StealLockout - dt);
        p.Immune = MathF.Max(0f, p.Immune - dt);

        // 3. A running action expires.
        if (p.Action != PlayerAction.None)
        {
            p.ActionTime -= dt;
            if (p.ActionTime <= 0f)
            {
                switch (p.Action)
                {
                    case PlayerAction.Slide when p.SlideHit:
                        p.Action = PlayerAction.Recover;
                        p.ActionTime = tk.HitRecover;
                        break;
                    case PlayerAction.Slide:
                        p.Action = PlayerAction.Stunned;
                        p.ActionTime = tk.MissStun;
                        result.Events |= MotionEvents.SlideMissed;
                        break;
                    case PlayerAction.Dive:
                        p.Action = PlayerAction.Recover;
                        p.ActionTime = tuning.Keeper.DiveRecover;
                        break;
                    default:
                        p.Action = PlayerAction.None;
                        p.ActionTime = 0f;
                        break;
                }
            }
        }

        // 4. Start a slide (no ball), a dash (with ball) or a dive (keeper).
        if (input.Tackle && p.Action == PlayerAction.None && p.TackleCooldown <= 0f)
        {
            Vec2 dir = input.Move.LengthSq > 0.04f ? input.Move.Normalized() : Vec2.FromAngle(p.Aim);
            if (p.IsKeeper)
            {
                var toAim = input.AimPoint - p.Pos;
                p.Action = PlayerAction.Dive;
                p.ActionTime = tuning.Keeper.DiveTime;
                p.ActionDir = toAim.LengthSq > 1f ? toAim.Normalized() : dir;
                p.TackleCooldown = p.DiveCooldown;
                result.Events |= MotionEvents.DiveStarted;
            }
            else if (hasBall)
            {
                if (p.Stamina >= tk.DashStaminaCost)
                {
                    p.Stamina -= tk.DashStaminaCost;
                    p.RegenDelay = pt.RegenDelay;
                    p.Action = PlayerAction.Dash;
                    p.ActionTime = tk.DashTime;
                    p.ActionDir = dir;
                    p.Immune = tk.DashImmune;
                    p.TackleCooldown = tk.Cooldown;
                    result.Events |= MotionEvents.DashStarted;
                }
            }
            else
            {
                p.Action = PlayerAction.Slide;
                p.ActionTime = tk.SlideTime;
                p.ActionDir = dir;
                p.SlideHit = false;
                p.TackleCooldown = tk.Cooldown;
                result.Events |= MotionEvents.SlideStarted;
            }
        }

        // 5. Shot charging. Only possible while free to act; anything else cancels the charge.
        bool canCharge = p.Action == PlayerAction.None || p.Action == PlayerAction.Dash;
        if (!canCharge)
        {
            p.Charging = false;
            p.Charge = 0f;
        }
        else if (input.Shoot)
        {
            p.Charging = true;
            p.Charge = MathF.Min(1f, p.Charge + dt / tuning.Kick.ChargeTime);
        }
        else if (p.Charging)
        {
            result.Events |= MotionEvents.ShotReleased;
            result.ReleasedCharge = p.Charge;
            p.Charging = false;
            p.Charge = 0f;
        }

        // 6. Velocity.
        p.Sprinting = false;
        switch (p.Action)
        {
            case PlayerAction.None:
            {
                Vec2 move = input.Move.ClampLength(1f);
                bool moving = move.LengthSq > 0.01f;
                bool sprint = input.Sprint && moving && !p.Exhausted && p.Stamina > 0f;
                float max = (sprint ? pt.SprintSpeed : pt.RunSpeed) * p.SpeedFactor;
                if (hasBall) max *= pt.DribbleSpeedFactor;
                if (p.Charging) max *= pt.ChargeMoveFactor;

                Vec2 dv = move * max - p.Vel;
                float maxDv = (moving ? pt.Accel : pt.Decel) * dt;
                p.Vel += dv.ClampLength(maxDv);

                if (sprint)
                {
                    p.Sprinting = true;
                    p.Stamina -= pt.SprintDrain * dt;
                    p.RegenDelay = pt.RegenDelay;
                    if (p.Stamina <= 0f)
                    {
                        p.Stamina = 0f;
                        p.Exhausted = true;
                    }
                }
                else
                {
                    Regenerate(ref p, pt, dt);
                }

                break;
            }
            case PlayerAction.Slide:
            {
                float k = 1f - MathUtil.Clamp01(p.ActionTime / tk.SlideTime);
                p.Vel = p.ActionDir * MathUtil.Lerp(tk.SlideSpeed, tk.SlideEndSpeed, k);
                Regenerate(ref p, pt, dt);
                break;
            }
            case PlayerAction.Dash:
                p.Vel = p.ActionDir * tk.DashSpeed;
                break;
            case PlayerAction.Dive:
            {
                float k = MathUtil.Clamp01(p.ActionTime / tuning.Keeper.DiveTime);
                p.Vel = p.ActionDir * (p.DiveSpeed * (0.35f + 0.65f * k));
                break;
            }
            default: // Stunned, Recover
                p.Vel *= MathF.Exp(-pt.StunFriction * dt);
                Regenerate(ref p, pt, dt);
                break;
        }

        // 7. Integrate and keep the footballer inside the walls.
        Vec2 wanted = p.Pos + p.Vel * dt;
        Vec2 clamped = pitch.ClampCircle(wanted, pt.Radius);
        if (clamped != wanted)
        {
            // Remove the velocity component that pushes into the wall.
            Vec2 n = (clamped - wanted).Normalized();
            float vn = Vec2.Dot(p.Vel, n);
            if (vn < 0f) p.Vel -= n * vn;
        }

        p.Pos = clamped;
        return result;
    }

    private static void Regenerate(ref PlayerState p, PlayerTuning pt, float dt)
    {
        if (p.RegenDelay > 0f)
        {
            p.RegenDelay = MathF.Max(0f, p.RegenDelay - dt);
            return;
        }

        p.Stamina = MathF.Min(1f, p.Stamina + pt.StaminaRegen * dt);
        if (p.Exhausted && p.Stamina >= pt.ExhaustedRecover) p.Exhausted = false;
    }
}
