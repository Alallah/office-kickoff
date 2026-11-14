// Goal replays. While the server sits in PHASE.REPLAY (nothing moves there) the browser plays the
// buffered snapshots around the goal again:
//
//   from  goal - rules.replayFootage   to  goal + rules.replayTail   over  rules.replayTime seconds
//
// with a speed curve that starts near real time and eases down to slow motion around the goal.
// Playback position is a pure function of the live phase timer, so the replay ends exactly when
// the server moves on and a late joiner lands in the right place.
//
// The footage after the goal was recorded while the simulation itself ran in slow motion
// (rules.goalSlowMoScale). Speeds here are in terms of normal play, so that stretch is played
// back faster in buffer time and the ball does not crawl into the net twice as slowly.
//
// Pure: no DOM.

import { EVT, PHASE, TICK_RATE } from '../shared/protocol.js';
import { CONFIG } from './config.js';
import { clamp, clamp01, finite, smoothstep } from './geom.js';

/**
 * Finds the goal a replay starting at `liveTime` belongs to and how much footage exists.
 * @param timeline  createTimeline() instance
 * @param rules     MatchInit.tuning.rules
 * @returns {?{goalTime:number, bufferStart:number, bufferEnd:number, kickoffTime:number, playStart:number, slowMo:boolean}}
 *          null when the goal is not in the buffer (joined after it)
 */
export function findReplayWindow(timeline, liveTime, rules) {
  const oldest = timeline.oldest;
  const latest = timeline.latest;
  if (!oldest || !latest) return null;
  const goal = timeline.findLastEvent(liveTime, (e) => e.type === EVT.GOAL);
  if (!goal) return null;
  const goalTime = goal.tick / TICK_RATE;
  // An older goal still in the buffer is not the one being replayed now.
  const longest = Math.max(rules.goalCelebrationTime, rules.goalShortTime) + rules.replayTime + 1.5;
  if (liveTime - goalTime > longest) return null;

  const before = goalTime - 0.5 / TICK_RATE;
  const kickoff = timeline.findLastEvent(before, (e) => e.type === EVT.PHASE_CHANGE && e.f === PHASE.KICKOFF);
  const play = timeline.findLastEvent(before, (e) => e.type === EVT.PHASE_CHANGE && e.f === PHASE.PLAYING);
  return {
    goalTime,
    bufferStart: oldest.time,
    bufferEnd: latest.time,
    kickoffTime: kickoff ? kickoff.tick / TICK_RATE : -Infinity,
    playStart: play ? play.tick / TICK_RATE : -Infinity,
  };
}

/**
 * Builds the playback plan.
 * @param w          findReplayWindow() result (times in server seconds)
 * @param rules      MatchInit.tuning.rules
 * @param slowScale  how slow the simulation ran right after the goal (rules.goalSlowMoScale)
 * @returns {?{start:number, end:number, goalTime:number, buildUpSpeed:number, slowSpeed:number, timeAt:(progress:number)=>number}}
 *          null when there is too little footage to show
 */
export function planReplay(w, rules, slowScale, cfg = CONFIG.replay) {
  let start = w.goalTime - rules.replayFootage;
  // A goal straight from the kickoff: show the play, not the countdown before it, and never the
  // other side of the teleport.
  if (w.playStart > -Infinity) start = Math.max(start, w.playStart - cfg.kickoffLead);
  if (w.kickoffTime > -Infinity) start = Math.max(start, w.kickoffTime);
  start = Math.max(start, w.bufferStart);
  const end = Math.min(w.goalTime + rules.replayTail, w.bufferEnd);
  if (!(end - start >= cfg.minFootage)) return null;

  const goalTime = clamp(w.goalTime, start, end);
  const scale = slowScale > 0 && slowScale <= 1 ? slowScale : 1;
  // Seconds of normal play before the goal and after it.
  const pre = goalTime - start;
  const post = (end - goalTime) * scale;
  const footage = pre + post;
  const total = Math.max(0.1, finite(rules.replayTime, 4.6));

  const steps = Math.max(8, Math.ceil(footage * 120));
  const ds = footage / steps;
  // 1 during the build-up, 0 in the slow motion around the goal.
  const shape = new Float64Array(steps);
  for (let i = 0; i < steps; i++) shape[i] = 1 - smoothstep(-cfg.easeFrom, -cfg.easeTo, (i + 0.5) * ds - pre);

  const slow = cfg.slowSpeed;
  const durationAt = (fast) => {
    let sum = 0;
    for (let i = 0; i < steps; i++) sum += ds / (slow + (fast - slow) * shape[i]);
    return sum;
  };

  // Solve the build-up speed so the footage fills the slot exactly; the slow motion keeps its speed.
  let fast;
  let gain = 1;
  if (footage / slow <= total) {
    // Too little footage even in slow motion throughout: one even speed, and if that would be
    // slower than slow motion deserves, the last frame is held instead.
    fast = slow;
    gain = Math.max(footage / slow / total, cfg.minSpeed / slow);
  } else if (durationAt(cfg.maxSpeed) > total) {
    fast = cfg.maxSpeed;
    gain = durationAt(fast) / total;
  } else {
    let lo = slow;
    let hi = cfg.maxSpeed;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (durationAt(mid) > total) lo = mid;
      else hi = mid;
    }
    fast = (lo + hi) / 2;
  }

  // cum[i] = playback seconds at which i * ds seconds of play have been shown.
  const cum = new Float64Array(steps + 1);
  for (let i = 0; i < steps; i++) cum[i + 1] = cum[i] + ds / ((slow + (fast - slow) * shape[i]) * gain);

  return {
    start,
    end,
    goalTime,
    buildUpSpeed: fast * gain,
    slowSpeed: slow * gain,
    /** Buffer time shown at replay progress 0..1. */
    timeAt(progress) {
      const r = clamp01(progress) * total;
      let s;
      if (r >= cum[steps]) {
        s = footage;
      } else {
        let lo = 0;
        let hi = steps;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] <= r) lo = mid;
          else hi = mid;
        }
        const span = cum[lo + 1] - cum[lo];
        s = (lo + (span > 0 ? (r - cum[lo]) / span : 0)) * ds;
      }
      return s <= pre ? start + s : Math.min(end, goalTime + (s - pre) / scale);
    },
  };
}

/** Playback state of the replay on screen (at most one). */
export function createReplay() {
  let plan = null;
  let progress = 0;
  let time = 0;
  let previous = 0;

  return {
    get active() { return plan !== null; },
    get plan() { return plan; },
    /** 0..1 through the replay. */
    get progress() { return progress; },
    /** Buffer time on screen, and the one shown the frame before (events in between are due). */
    get time() { return time; },
    get previousTime() { return previous; },

    /**
     * @param p             planReplay() result
     * @param liveProgress  0..1: how far the server's replay phase has already run. Playback starts
     *                      there (joined or came back mid-replay), without the events before it.
     */
    begin(p, liveProgress = 0) {
      plan = p;
      progress = clamp01(liveProgress);
      time = p.timeAt(progress);
      previous = time;
    },

    /**
     * @param liveProgress 0..1: how far the server's replay phase has run
     * @returns {number} buffer time to show; never runs backwards
     */
    update(liveProgress) {
      if (!plan) return time;
      progress = Math.max(progress, clamp01(liveProgress));
      previous = time;
      time = Math.max(time, plan.timeAt(progress));
      return time;
    },

    end() {
      plan = null;
      progress = 0;
    },
  };
}
