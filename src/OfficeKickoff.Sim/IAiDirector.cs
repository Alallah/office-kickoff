namespace OfficeKickoff.Sim;

/// <summary>Read-only view of a match handed to the AI every tick.</summary>
public sealed class AiContext
{
    public required MatchState State { get; init; }
    public required PitchGeometry Pitch { get; init; }
    public required Tuning Tuning { get; init; }
    public required MatchConfig Config { get; init; }

    /// <summary>The match's seeded random source. Use only this so matches stay reproducible.</summary>
    public required Random Rng { get; init; }
}

/// <summary>
/// Drives every footballer that no human controls (all goalkeepers, plus outfield footballers
/// whose <see cref="PlayerState.Controller"/> is -1). The AI plays through the same
/// <see cref="PlayerInput"/> as a human: it may READ the whole <see cref="MatchState"/> but must
/// never mutate it.
/// </summary>
public interface IAiDirector
{
    /// <summary>Called when the match starts and after every kickoff reset: forget all plans.</summary>
    void Reset(AiContext ctx);

    /// <summary>
    /// Called once per tick during Playing and GoalScored, before inputs are applied.
    /// Write <c>inputs[i]</c> for every footballer <c>i</c> with Controller == -1 and leave the
    /// other entries untouched. <c>inputs</c> has one entry per footballer, indexed like
    /// <see cref="MatchState.Players"/>. Edge fields (Pass, Tackle) must be true for one tick only.
    /// </summary>
    /// <param name="dt">Simulation seconds for this tick.</param>
    void Think(AiContext ctx, PlayerInput[] inputs, float dt);
}
