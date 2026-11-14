namespace OfficeKickoff.Sim;

/// <summary>
/// The controls of one footballer for one tick. Humans and AI drive footballers through exactly
/// the same structure, so anything a human can do the AI can do, and vice versa.
/// </summary>
public struct PlayerInput
{
    /// <summary>Desired movement direction; length 0..1 (longer vectors are clamped).</summary>
    public Vec2 Move;

    /// <summary>World-space point the footballer aims at (the mouse cursor for humans).</summary>
    public Vec2 AimPoint;

    /// <summary>Held: sprint while stamina lasts.</summary>
    public bool Sprint;

    /// <summary>Held: charge a shot. Releasing it (true on one tick, false on the next) fires.</summary>
    public bool Shoot;

    /// <summary>Edge (true for exactly one tick): pass towards the team-mate nearest the aim direction.</summary>
    public bool Pass;

    /// <summary>
    /// Edge: slide tackle without the ball, dash with the ball, dive for a goalkeeper
    /// (a keeper dives towards <see cref="AimPoint"/>).
    /// </summary>
    public bool Tackle;

    /// <summary>Edge, humans only: take control of the team-mate best placed to reach the ball.</summary>
    public bool SwitchBest;

    /// <summary>Edge, humans only: cycle control to the next available team-mate.</summary>
    public bool SwitchNext;
}
