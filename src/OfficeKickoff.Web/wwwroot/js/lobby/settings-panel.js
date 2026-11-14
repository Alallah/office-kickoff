// The match settings panel. The host edits; everyone else sees the same controls read-only.
// What is shown and when it is sent is decided by createSettingsSync (settings-model.js): the
// host's edits appear at once and go out as one whole MatchSettingsDto a moment later, and a
// RoomState that is older than an edit never drags a control back.

import { LIMITS } from '../shared/protocol.js';
import { debounce, h, icon, setAttr, setHidden, setText } from './dom.js';
import {
  AI_LEVELS,
  SPEED_STEP,
  createSettingsSync,
  formatMinutes,
  formatScoreLimit,
  formatSpeed,
  summarizeSettings,
} from './settings-model.js';
import { segmented, slider, toggle } from './widgets.js';

const SEND_DELAY_MS = 200;

function field(label, control, className = '') {
  return h('div', { class: `field ${className}`.trim() }, h('span', { class: 'label', text: label }), control);
}

/**
 * @param {{catalog: object, actions: {setSettings: (settings: object) => boolean}}} opts
 */
export function createSettingsPanel({ catalog, actions }) {
  const presets = (Array.isArray(catalog.settingsPresets) ? catalog.settingsPresets : []).filter(
    (p) => p && typeof p.id === 'string' && p.id !== '',
  );
  const sync = createSettingsSync(presets);
  let reconcileTimer = 0;

  const send = debounce(() => {
    const out = sync.takeOutgoing(performance.now());
    if (!out) return;
    actions.setSettings(out);
    // If the echo never matches (refused, adjusted, or lost on a broken connection) the panel
    // falls back to what the server has.
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      if (sync.reconcile(performance.now())) paint();
    }, sync.echoTimeoutMs + 50);
  }, SEND_DELAY_MS);

  const edit = (name) => (value) => {
    if (!sync.edit(name, value)) return;
    paint();
    send();
  };

  const sizes = [];
  for (let n = LIMITS.minTeamSize; n <= LIMITS.maxTeamSize; n++) sizes.push(n);
  const levels = AI_LEVELS.map((label, value) => ({ value, label }));

  const sizeOptions = (keepers) =>
    sizes.map((n) => ({ value: n, label: String(n), title: keepers ? `${n}-a-side, keeper included` : `${n}-a-side, no keepers` }));
  let sizeKeepers = true;
  const teamSize = segmented({
    label: 'Team size',
    options: sizeOptions(sizeKeepers),
    onChange: edit('teamSize'),
  });
  const minutes = slider({
    label: 'Match length',
    min: LIMITS.minMinutes,
    max: LIMITS.maxMinutes,
    step: 1,
    format: formatMinutes,
    onInput: edit('minutes'),
  });
  const scoreLimit = slider({
    label: 'Score limit',
    min: 0,
    max: LIMITS.maxScoreLimit,
    step: 1,
    format: formatScoreLimit,
    onInput: edit('scoreLimit'),
  });
  const goldenGoal = toggle({
    label: 'Golden goal',
    title: 'Level at full time: play on until someone scores. Off: the match ends as a draw.',
    onChange: edit('goldenGoal'),
  });
  const keepers = toggle({
    label: 'Goalkeepers',
    title: 'An AI goalkeeper in each goal. Off: smaller goals, and every footballer plays outfield.',
    onChange: edit('keepers'),
  });
  const aiTeammates = segmented({ label: 'AI team-mates', options: levels, onChange: edit('aiTeammates') });
  const aiKeeper = segmented({ label: 'AI keepers', options: levels, onChange: edit('aiKeeper') });
  // Without goalkeepers there is no keeper difficulty to choose.
  const aiKeeperField = field('AI keepers', aiKeeper.el);
  const ballSpeed = slider({
    label: 'Ball speed',
    min: LIMITS.minSpeed,
    max: LIMITS.maxSpeed,
    step: SPEED_STEP,
    format: formatSpeed,
    onInput: edit('ballSpeed'),
  });
  const gameSpeed = slider({
    label: 'Game speed',
    min: LIMITS.minSpeed,
    max: LIMITS.maxSpeed,
    step: SPEED_STEP,
    format: formatSpeed,
    onInput: edit('gameSpeed'),
  });
  const replays = toggle({ label: 'Goal replays', title: 'Show a replay after every goal', onChange: edit('replays') });
  const celebrations = toggle({ label: 'Celebrations', title: 'Let the scorer celebrate after a goal', onChange: edit('celebrations') });

  const chips = presets.map((preset) => {
    const el = h('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': 'false',
      title: preset.description,
      text: preset.label || preset.id,
      onClick: () => {
        if (!sync.choosePreset(preset.id)) return;
        paint();
        send();
      },
    });
    return { preset, el };
  });
  // "Custom" takes the place a preset's description has: it appears once the rules match no preset.
  const customTag = h('span', { class: 'tag tag-custom', text: 'Custom', title: 'The rules were edited and match no preset', hidden: true });
  const summaryText = h('span');
  const summary = h('p', { class: 'settings-summary' }, customTag, summaryText);

  const fields = h(
    'fieldset',
    { class: 'settings-fields', 'aria-label': 'Match settings' },
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Rule presets' }, chips.map((c) => c.el)),
    summary,
    h(
      'div',
      { class: 'settings-grid' },
      field('Team size', teamSize.el),
      field('Match length', minutes.el),
      field('Score limit', scoreLimit.el),
      field('Tie-break', goldenGoal.el),
      field('In goal', keepers.el),
      field('AI team-mates', aiTeammates.el),
      aiKeeperField,
      field('Ball speed', ballSpeed.el),
      field('Game speed', gameSpeed.el),
      field('After a goal', h('div', { class: 'switch-pair' }, replays.el, celebrations.el), 'field-wide'),
    ),
  );

  const guestNote = h('p', { class: 'settings-note', hidden: true }, icon('eye', 14), h('span', { text: 'Only the host can change these' }));
  const practiceNote = h('p', {
    class: 'settings-note settings-practice',
    hidden: true,
    title: 'Match length, score limit and golden goal only count in a real match',
    text: 'Practice: no clock, no score limit.',
  });

  const el = h(
    'section',
    { class: 'settings panel', 'aria-labelledby': 'settings-title' },
    h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title display', id: 'settings-title', text: 'Match settings' }), guestNote),
    fields,
    practiceNote,
  );

  function paint() {
    const s = sync.local;
    if (sizeKeepers !== s.keepers) {
      sizeKeepers = s.keepers;
      teamSize.setOptions(sizeOptions(sizeKeepers));
    }
    teamSize.set(s.teamSize);
    minutes.set(s.minutes);
    scoreLimit.set(s.scoreLimit);
    goldenGoal.set(s.goldenGoal);
    keepers.set(s.keepers);
    aiTeammates.set(s.aiTeammates);
    aiKeeper.set(s.aiKeeper);
    setHidden(aiKeeperField, !s.keepers);
    ballSpeed.set(s.ballSpeed);
    gameSpeed.set(s.gameSpeed);
    replays.set(s.replays);
    celebrations.set(s.celebrations);

    let active = null;
    for (const chip of chips) {
      const on = chip.preset.id === s.preset;
      setAttr(chip.el, 'aria-pressed', on ? 'true' : 'false');
      if (on) active = chip.preset;
    }
    setHidden(customTag, active !== null);
    setText(summaryText, active ? active.description || summarizeSettings(s) : `${summarizeSettings(s)}.`);
  }

  return {
    el,
    /** @param {object} ctx  the lobby's render context (see lobby.js) */
    update(ctx) {
      const isHost = ctx.view.isHost;
      sync.onServer(ctx.room.settings, isHost, performance.now());
      if (fields.disabled === isHost) fields.disabled = !isHost;
      setHidden(guestNote, isHost);
      setHidden(practiceNote, ctx.room.practice !== true);
      paint();
    },
    /** Sends an edit that is still waiting out its delay (called before Start, so the match gets it). */
    flush() {
      send.flush();
    },
  };
}
