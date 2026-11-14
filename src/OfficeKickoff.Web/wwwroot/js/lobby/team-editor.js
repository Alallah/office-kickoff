// The team editor: a modal for one side's team - name, code, kit colours, crest, formation and
// squad - with a live preview, "My teams" (kept on this computer) and import / export.
//
// What was typed lives in `form`, exactly as typed. Every change turns it into a valid team with
// sanitizeTeam: that `draft` is what the preview shows and what Apply sends. The server validates
// again, so after Apply the editor shows what the server actually accepted.

import { crestSvg } from '../shared/crests.js';
import { deleteMyTeam, saveMyTeam } from '../shared/identity.js';
import { LIMITS } from '../shared/protocol.js';
import { copyText } from '../shared/util.js';
import { createModal, h, hasFocus, icon, replay, setAttr, setClass, setHidden, setText, toast } from './dom.js';
import { listNames } from './logic.js';
import { createMiniPitch } from './pitch.js';
import {
  KIT_SWATCHES,
  allFormationNames,
  basePresetId,
  cleanTeamCode,
  codeFromName,
  crestLabel,
  exportFileName,
  exportTeam,
  formationsFor,
  kitOf,
  kitOfConfig,
  parseTeamImport,
  presetById,
  resolveFormation,
  sanitizeTeam,
  savedIdByName,
  teamWarnings,
  teamsEqual,
} from './team-model.js';
import { colorInput, segmented, swatches, uniqueId } from './widgets.js';

/** identity.js keeps this many saved teams and drops the oldest beyond it. */
const SAVED_LIMIT = 24;

/** Team files are tiny; a bigger file is something else and is not even read. */
const MAX_FILE_BYTES = 200000;

const COLOR_PARTS = Object.freeze([
  Object.freeze({ key: 'primary', label: 'Shirt', part: 'shirt colour' }),
  Object.freeze({ key: 'secondary', label: 'Trim', part: 'trim colour' }),
  Object.freeze({ key: 'keeper', label: 'Keeper', part: 'keeper colour' }),
]);

function readFileText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * @param {{catalog: object, background: HTMLElement,
 *          actions: {applyTeam: (team: number, config: object) => Promise<{status: string, changed: string[], accepted: ?object}>,
 *                    teamsChanged: () => void}}} opts
 *        `background` is the page root, switched off while the editor is open.
 *        `applyTeam` resolves with what became of the change: status 'accepted' | 'adjusted' |
 *        'refused' | 'offline' | 'superseded'. `teamsChanged` is called after "My teams" was written.
 */
export function createTeamEditor({ catalog, background, actions }) {
  const presets = Array.isArray(catalog.teamPresets) ? catalog.teamPresets.filter((p) => p && typeof p.name === 'string') : [];
  const crests = Array.isArray(catalog.crests) && catalog.crests.length > 0 ? catalog.crests : ['shield'];
  const knownFormations = allFormationNames(catalog.formations);
  const clean = (raw, fallback) => sanitizeTeam(raw, { fallback, crests, formations: knownFormations });

  const titleId = uniqueId('editor-title');
  const modal = createModal({ className: 'editor', labelledBy: titleId, background, onRequestClose: () => requestClose() });

  let ui = null;
  let ctx = null;
  let team = 0;
  let teamSize = 5;
  /** MatchSettingsDto.keepers: false makes slot 0 an ordinary footballer. */
  let keepers = true;
  /** The server's team the form was last loaded from: the yardstick for "edited". */
  let baseline = null;
  /** The server's team right now (it can move while the editor is open). */
  let server = null;
  /** Raw values, as typed. */
  let form = null;
  /** sanitizeTeam(form): a team that is always valid. */
  let draft = null;
  let busy = false;
  let shownSaved = null;
  const shown = { crest: '', colors: '' };
  /** Preset each side is, or was before it was edited, based on. */
  const baseIds = [null, null];

  const sizeOf = (c) => c?.room?.settings?.teamSize ?? 5;
  const keepersOf = (c) => c?.room?.settings?.keepers !== false;
  const canEdit = () => ctx?.view?.canEdit?.[team] === true;
  const dirty = () => Boolean(draft && baseline) && !teamsEqual(draft, baseline);

  // ---------------------------------------------------------------------------------------
  //  Construction (on first open)
  // ---------------------------------------------------------------------------------------

  function colorRow({ key, label }) {
    const chip = colorInput({
      label: `${label} colour: pick any colour`,
      onInput: (hex) => {
        form[key] = hex;
        dots.set(hex);
        paint();
      },
    });
    const dots = swatches({
      label: `${label} colour`,
      colors: KIT_SWATCHES,
      onPick: (hex) => {
        form[key] = hex;
        chip.set(hex);
        paint();
      },
    });
    const el = h('div', { class: 'kit-row' }, h('span', { class: 'kit-row-label', text: label }), chip.el, dots.el);
    return {
      el,
      set(hex) {
        chip.set(hex);
        dots.set(hex);
      },
    };
  }

  function rosterRow(slot) {
    const who = `player ${slot + 1}`;
    const number = h('input', {
      class: 'input roster-number tnum',
      type: 'text',
      inputmode: 'numeric',
      maxlength: 2,
      autocomplete: 'off',
      'aria-label': `Shirt number of the ${who}`,
    });
    const name = h('input', {
      class: 'input roster-name',
      type: 'text',
      maxlength: LIMITS.rosterName,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': `Name of the ${who}`,
    });
    number.addEventListener('input', () => {
      const digits = number.value.replace(/\D/g, '').slice(0, 2);
      if (digits !== number.value) number.value = digits;
      typed();
    });
    name.addEventListener('input', typed);
    const pos = h('span', { class: 'roster-pos display' });
    const el = h('li', { class: 'roster-row' }, pos, number, name);
    const row = { el, number, name, pos };
    paintRosterRow(row, slot);
    return row;
  }

  /** Slot 0 is the goalkeeper, or with goalkeepers off an ordinary footballer like the rest. */
  function paintRosterRow(row, slot) {
    const keeper = slot === 0 && keepers;
    const who = keeper ? 'goalkeeper' : `player ${slot + 1}`;
    setText(row.pos, keeper ? 'GK' : String(slot + 1));
    setAttr(row.pos, 'title', keeper ? 'Goalkeeper (always played by the AI)' : slot === 0 ? 'Sweeper: plays outfield while there are no goalkeepers' : `Outfield slot ${slot}`);
    setClass(row.el, 'is-keeper', keeper);
    setAttr(row.number, 'aria-label', `Shirt number of the ${who}`);
    setAttr(row.name, 'aria-label', `Name of the ${who}`);
  }

  function build() {
    if (ui) return;

    const title = h('h2', { class: 'editor-title display', id: titleId, text: 'Edit team' });
    const sideTag = h('span', { class: 'tag editor-side' });
    const lock = h('span', { class: 'editor-lock', hidden: true }, icon('eye', 14), h('span', { text: "Only the host and this team's players can apply changes" }));
    const closeBtn = h(
      'button',
      { class: 'btn btn-icon btn-ghost', type: 'button', 'aria-label': 'Close the editor', title: 'Close (Esc)', onClick: () => requestClose() },
      icon('close', 18),
    );

    // ---- identity ---------------------------------------------------------------------------
    const nameId = uniqueId('team-name');
    const codeId = uniqueId('team-code');
    const name = h('input', {
      class: 'input',
      type: 'text',
      id: nameId,
      maxlength: LIMITS.teamName,
      autocomplete: 'off',
      spellcheck: 'false',
      'data-autofocus': '',
    });
    const code = h('input', {
      class: 'input code-field display',
      type: 'text',
      id: codeId,
      maxlength: LIMITS.teamCode,
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
    });
    name.addEventListener('input', typed);
    code.addEventListener('input', () => {
      const next = cleanTeamCode(code.value);
      if (next !== code.value) {
        const caret = Math.min(code.selectionStart ?? next.length, next.length);
        code.value = next;
        try {
          code.setSelectionRange(caret, caret);
        } catch {
          /* the caret simply goes to the end */
        }
      }
      typed();
    });

    const colors = COLOR_PARTS.map((part) => ({ ...part, row: colorRow(part) }));

    const crestGroup = uniqueId('crest');
    const crestOptions = crests.map((id) => {
      const input = h('input', { type: 'radio', class: 'crest-input', name: crestGroup, value: id, 'aria-label': crestLabel(id) });
      const face = h('span', { class: 'crest-face', 'aria-hidden': 'true' });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        form.crest = id;
        paint();
      });
      return { id, input, face, el: h('label', { class: 'crest-option', title: crestLabel(id) }, input, face) };
    });

    const formation = segmented({
      label: 'Formation',
      options: [],
      onChange: (value) => {
        form.formation = value;
        paint();
      },
    });
    const formationFor = h('span', { class: 'label-note' });
    const warnings = h('ul', { class: 'editor-warnings', 'aria-label': 'Things to check' });

    const fields = {
      name: h('div', { class: 'field field-grow' }, h('label', { class: 'label', for: nameId, text: 'Team name' }), name),
      code: h('div', { class: 'field field-code' }, h('label', { class: 'label', for: codeId, text: 'Code' }), code),
      kit: h('div', { class: 'field' }, h('span', { class: 'label', text: 'Kit colours' }), h('div', { class: 'kit-rows' }, colors.map((c) => c.row.el))),
      crest: h(
        'div',
        { class: 'field' },
        h('span', { class: 'label', text: 'Crest' }),
        h('div', { class: 'crest-picker', role: 'radiogroup', 'aria-label': 'Crest' }, crestOptions.map((o) => o.el)),
      ),
      formation: h('div', { class: 'field' }, h('span', { class: 'label' }, 'Formation ', formationFor), formation.el),
    };
    const identity = h(
      'section',
      { class: 'editor-col editor-identity', 'aria-label': 'Name, kit and formation' },
      h('div', { class: 'field-row' }, fields.name, fields.code),
      fields.kit,
      fields.crest,
      fields.formation,
      warnings,
    );

    // ---- squad ------------------------------------------------------------------------------
    const rows = [];
    for (let slot = 0; slot < LIMITS.rosterSize; slot++) rows.push(rosterRow(slot));
    const bench = h('li', { class: 'roster-divider', hidden: true });
    const rosterList = h('ol', { class: 'roster' }, rows.map((row) => row.el));
    const rosterHint = h('span', { class: 'label-note' });
    const roster = h(
      'section',
      { class: 'editor-col editor-roster', 'aria-label': 'Squad' },
      h('span', { class: 'label' }, 'Squad ', rosterHint),
      rosterList,
    );
    // Enter and the up / down arrows walk the squad list like a spreadsheet column.
    rosterList.addEventListener('keydown', (e) => {
      const step = e.key === 'Enter' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      const column = rows.some((row) => row.number === e.target) ? 'number' : 'name';
      const at = rows.findIndex((row) => row[column] === e.target);
      const next = rows[at + step];
      if (at < 0 || !next) return;
      e.preventDefault();
      next[column].focus();
      next[column].select();
    });

    // ---- preview ----------------------------------------------------------------------------
    const previewCrest = h('div', { class: 'preview-crest', 'aria-hidden': 'true' });
    const previewName = h('strong', { class: 'preview-name display' });
    const previewCode = h('span', { class: 'preview-code display' });
    const previewPitch = h('div', { class: 'preview-pitch' });
    const preview = h(
      'div',
      { class: 'preview', 'aria-label': 'Preview' },
      h('div', { class: 'preview-head' }, previewCrest, previewName, previewCode),
      previewPitch,
    );

    // ---- my teams, import, export -------------------------------------------------------------
    const saveBtn = h('button', { class: 'btn btn-sm', type: 'button', onClick: saveToMine }, icon('save', 14), h('span', { text: 'Save this team' }));
    const savedList = h('ul', { class: 'saved-list', 'aria-label': 'My teams' });
    const savedEmpty = h('p', { class: 'hint saved-empty', text: 'Teams you save stay on this computer, ready for the next room.' });

    const pasteArea = h('textarea', {
      class: 'input paste-area',
      rows: 4,
      spellcheck: 'false',
      placeholder: 'Paste the text of a team here',
      'aria-label': 'Team text to import',
    });
    const pasteBox = h(
      'div',
      { class: 'paste-box', hidden: true },
      pasteArea,
      h(
        'div',
        { class: 'paste-actions' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', text: 'Import this text', onClick: () => importText(pasteArea.value) }),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Close', onClick: () => hidePaste(true) }),
      ),
    );

    const fileInput = h('input', { class: 'file-input', type: 'file', accept: '.json,application/json,text/plain' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      // Cleared so that picking the same file again fires `change` again.
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        say('That file is too big to be a team file.', 'error');
        return;
      }
      let text;
      try {
        text = await readFileText(file);
      } catch {
        say('That file could not be read.', 'error');
        return;
      }
      importText(text);
    });
    const pasteBtn = h(
      'button',
      { class: 'btn btn-sm', type: 'button', 'aria-expanded': 'false', onClick: () => (pasteBox.hidden ? showPaste('') : hidePaste(true)) },
      icon('paste', 14),
      h('span', { text: 'Paste text' }),
    );
    const library = h(
      'div',
      { class: 'library' },
      h('div', { class: 'library-head' }, h('span', { class: 'label', text: 'My teams' }), saveBtn),
      savedList,
      savedEmpty,
      pasteBox,
      h(
        'div',
        { class: 'share-grid' },
        h('label', { class: 'btn btn-sm file-btn', title: 'Import a team from a .json file' }, fileInput, icon('upload', 14), h('span', { text: 'Import file' })),
        pasteBtn,
        h('button', { class: 'btn btn-sm', type: 'button', title: 'Download this team as a .json file', onClick: download }, icon('download', 14), h('span', { text: 'Download' })),
        h('button', { class: 'btn btn-sm', type: 'button', title: 'Copy this team as text', onClick: copyTeam }, icon('copy', 14), h('span', { text: 'Copy' })),
      ),
    );

    const aside = h('section', { class: 'editor-col editor-aside', 'aria-label': 'Preview and my teams' }, preview, library);

    // ---- footer -----------------------------------------------------------------------------
    const statusText = h('span', { class: 'editor-status-text' });
    const statusAction = h('button', { class: 'link-btn', type: 'button', hidden: true });
    const status = h('p', { class: 'editor-status', role: 'status' }, statusText, statusAction);
    const resetBtn = h('button', { class: 'btn', type: 'button', onClick: resetToPreset }, icon('undo', 15), h('span', { text: 'Reset to preset' }));
    const cancelLabel = h('span', { text: 'Close' });
    const cancelBtn = h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => requestClose() }, cancelLabel);
    const applyLabel = h('span', { text: 'Apply' });
    const applyBtn = h('button', { class: 'btn btn-primary btn-apply', type: 'button', onClick: apply }, icon('check', 16), applyLabel);

    const body = h('div', { class: 'editor-body' }, identity, roster, aside);
    // Leaving a field shows what its text turned into (trimmed, clamped, or put back when emptied).
    body.addEventListener('focusout', () => {
      if (form) syncInputs();
    });

    modal.panel.append(
      h('header', { class: 'editor-head' }, title, sideTag, lock, h('span', { class: 'editor-head-space' }), closeBtn),
      body,
      h('footer', { class: 'editor-foot' }, status, resetBtn, cancelBtn, applyBtn),
    );
    // Ctrl+Enter applies from anywhere in the editor.
    modal.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        apply();
      }
    });

    ui = {
      title, sideTag, lock, name, code, colors, crestOptions, formation, formationFor, warnings, fields,
      roster, rows, bench, rosterList, rosterHint, preview, previewCrest, previewName, previewCode, previewPitch,
      pitches: [null, null], saveBtn, savedList, savedEmpty, pasteArea, pasteBox, pasteBtn,
      statusText, statusAction, status, resetBtn, cancelLabel, applyLabel, applyBtn,
    };
  }

  // ---------------------------------------------------------------------------------------
  //  Form <-> inputs
  // ---------------------------------------------------------------------------------------

  /** Text the user is typing: pulled from the inputs into `form` (colours, crest and formation go straight in). */
  function readInputs() {
    form.name = ui.name.value;
    form.code = ui.code.value;
    form.roster = ui.rows.map((row) => ({ name: row.name.value, number: row.number.value }));
  }

  function typed() {
    readInputs();
    paint();
  }

  /** Shows `draft` in every text input that is not being typed in. */
  function syncInputs() {
    const put = (input, value) => {
      const text = String(value);
      if (!hasFocus(input) && input.value !== text) input.value = text;
    };
    put(ui.name, draft.name);
    put(ui.code, draft.code);
    ui.rows.forEach((row, slot) => {
      put(row.name, draft.roster[slot].name);
      put(row.number, draft.roster[slot].number);
    });
    readInputs();
  }

  /**
   * Puts a team into the form. With `force` every input is overwritten (the user asked for this
   * team); without it an input that has the focus is left alone.
   */
  function setForm(config, force = true) {
    const next = clean(config, baseline ?? undefined);
    form = {
      presetId: next.presetId,
      name: next.name,
      code: next.code,
      primary: next.primary,
      secondary: next.secondary,
      keeper: next.keeper,
      crest: next.crest,
      formation: next.formation,
      roster: next.roster.map((entry) => ({ name: entry.name, number: String(entry.number) })),
    };
    const put = (input, value) => {
      if (force || !hasFocus(input)) input.value = String(value);
    };
    put(ui.name, next.name);
    put(ui.code, next.code);
    ui.rows.forEach((row, slot) => {
      put(row.name, next.roster[slot].name);
      put(row.number, next.roster[slot].number);
    });
    for (const color of ui.colors) color.row.set(next[color.key]);
    for (const option of ui.crestOptions) {
      const on = option.id === next.crest;
      if (option.input.checked !== on) option.input.checked = on;
    }
    // Whatever stayed in a focused input is what the form now holds.
    readInputs();
    paint();
  }

  /** Makes a server team both the yardstick and the content of the form. */
  function loadTeam(config, force = true) {
    baseline = clean(config);
    server = baseline;
    setForm(baseline, force);
  }

  // ---------------------------------------------------------------------------------------
  //  Painting
  // ---------------------------------------------------------------------------------------

  function paintSide() {
    setText(ui.title, canEdit() ? 'Edit team' : 'Team (read only)');
    setText(ui.sideTag, team === 0 ? 'Home side' : 'Away side');
    setClass(ui.sideTag, 'is-away', team === 1);
    if (!ui.pitches[team]) ui.pitches[team] = createMiniPitch({ flip: team === 1 });
    if (ui.previewPitch.firstChild !== ui.pitches[team].el) ui.previewPitch.replaceChildren(ui.pitches[team].el);
  }

  function paintTeamSize() {
    const options = formationsFor(teamSize, catalog.formations);
    ui.formation.setOptions(options.map((name) => ({ value: name, label: name, title: `${name}: defence to attack` })));
    setText(ui.formationFor, `for ${teamSize}-a-side`);
    setText(ui.rosterHint, teamSize < LIMITS.rosterSize ? `the first ${teamSize} play at ${teamSize}-a-side` : 'all seven play');
    ui.rows.forEach((row, slot) => setClass(row.el, 'is-bench', slot >= teamSize));
    if (teamSize < LIMITS.rosterSize) {
      setText(ui.bench, `Not on the pitch at ${teamSize}-a-side`);
      ui.rosterList.insertBefore(ui.bench, ui.rows[teamSize].el);
    }
    setHidden(ui.bench, teamSize >= LIMITS.rosterSize);
  }

  function paintKeepers() {
    ui.rows.forEach((row, slot) => paintRosterRow(row, slot));
  }

  function paintButtons() {
    const allowed = canEdit();
    const changed = Boolean(server) && !teamsEqual(draft, server);
    // While busy the button stays focusable (apply() ignores presses): disabling it would throw the
    // keyboard focus out of the dialog.
    ui.applyBtn.disabled = !busy && (!allowed || !changed);
    setAttr(ui.applyBtn, 'aria-disabled', busy ? 'true' : null);
    setText(ui.applyLabel, busy ? 'Applying' : 'Apply');
    setClass(ui.applyBtn, 'is-busy', busy);
    setAttr(
      ui.applyBtn,
      'title',
      !allowed ? "Only the host and this team's players can change it" : changed ? 'Put this team on the pitch (Ctrl+Enter)' : 'This is the team on the pitch already',
    );
    setHidden(ui.lock, allowed);

    const preset = presetById(presets, baseIds[team]);
    const atPreset = preset !== null && teamsEqual(draft, clean(preset));
    ui.resetBtn.disabled = busy || preset === null || atPreset;
    setAttr(ui.resetBtn, 'title', preset === null ? 'This team is not based on a preset' : atPreset ? `This is ${preset.name} already` : `Back to ${preset.name}`);

    setText(ui.cancelLabel, dirty() ? 'Cancel' : 'Close');
    setAttr(ui.saveBtn, 'title', savedIdByName(ctx?.myTeams ?? [], draft.name) ? `Replace "${draft.name}" in My teams` : 'Keep this team on this computer');
  }

  function paintWarnings() {
    const other = ctx?.room?.teams?.[1 - team];
    const list = teamWarnings(draft, {
      otherName: other?.config?.name,
      otherPrimary: other ? kitOf(other).primary : undefined,
      teamSize,
    });
    const signature = list.join('\n');
    if (ui.warnings.dataset.shown === signature) return;
    ui.warnings.dataset.shown = signature;
    ui.warnings.replaceChildren(...list.map((text) => h('li', { class: 'editor-warning' }, icon('warning', 13), h('span', { text }))));
    setHidden(ui.warnings, list.length === 0);
  }

  /** Recomputes the draft from the form and brings everything that shows it up to date. */
  function paint() {
    draft = clean({ ...form }, baseline ?? undefined);
    const kit = kitOfConfig(draft);

    const crestKey = `${draft.crest}|${draft.primary}|${draft.secondary}`;
    if (crestKey !== shown.crest) {
      ui.previewCrest.innerHTML = crestSvg(draft.crest, draft.primary, draft.secondary, { size: 52 });
      if (shown.crest !== '' && !shown.crest.startsWith(`${draft.crest}|`)) replay(ui.previewCrest, 'is-pop');
      shown.crest = crestKey;
    }
    const colorKey = `${draft.primary}|${draft.secondary}`;
    if (colorKey !== shown.colors) {
      // The picker shows every crest in the team's own colours.
      for (const option of ui.crestOptions) option.face.innerHTML = crestSvg(option.id, draft.primary, draft.secondary, { size: 30 });
      shown.colors = colorKey;
    }

    setText(ui.previewName, draft.name);
    setText(ui.previewCode, draft.code);
    ui.preview.style.setProperty('--kit', kit.primary);
    ui.preview.style.setProperty('--kit-2', kit.secondary);
    ui.preview.style.setProperty('--kit-ink', kit.text);

    const formation = resolveFormation(draft.formation, teamSize, catalog.formations);
    ui.formation.set(formation);
    ui.pitches[team]?.update({ formation, teamSize, keepers, roster: draft.roster, kit });

    // An emptied code box shows what will be used instead.
    setAttr(ui.code, 'placeholder', codeFromName(draft.name));
    paintWarnings();
    paintButtons();
  }

  /**
   * The line in the footer that says what just happened.
   * @param {string} text
   * @param {'info'|'ok'|'warn'|'error'} [tone]
   * @param {?{label: string, run: () => void}} [action]
   */
  function say(text, tone = 'info', action = null) {
    if (!ui) return;
    setText(ui.statusText, text);
    ui.status.className = `editor-status is-${tone}`;
    setHidden(ui.statusAction, !action);
    if (action) {
      setText(ui.statusAction, action.label);
      ui.statusAction.onclick = () => action.run();
    } else {
      ui.statusAction.onclick = null;
    }
  }

  /** A short flash on the fields the server changed. */
  function flashParts(parts) {
    const targets = { name: ui.fields.name, code: ui.fields.code, crest: ui.fields.crest, formation: ui.fields.formation, roster: ui.roster };
    for (const color of ui.colors) targets[color.part] = color.row.el;
    for (const part of parts) {
      if (targets[part]) replay(targets[part], 'is-adjusted');
    }
  }

  // ---------------------------------------------------------------------------------------
  //  My teams
  // ---------------------------------------------------------------------------------------

  function paintSaved(list) {
    shownSaved = list;
    ui.savedList.replaceChildren(
      ...list.map((entry) => {
        const art = h('span', { class: 'saved-crest', 'aria-hidden': 'true' });
        art.innerHTML = crestSvg(entry.team.crest, entry.team.primary, entry.team.secondary, { size: 22 });
        return h(
          'li',
          { class: 'saved-item' },
          h(
            'button',
            {
              class: 'saved-load',
              type: 'button',
              title: `Load ${entry.team.name} into the editor`,
              onClick: () => {
                setForm({ ...entry.team, presetId: null });
                say(`Loaded "${entry.team.name}". Apply to put it on the pitch.`, 'ok');
              },
            },
            art,
            h('span', { class: 'saved-name', text: entry.team.name }),
            h('span', { class: 'saved-code display', text: entry.team.code }),
          ),
          h(
            'button',
            {
              class: 'btn btn-icon btn-ghost saved-delete',
              type: 'button',
              'aria-label': `Delete ${entry.team.name} from My teams`,
              title: 'Delete from My teams',
              onClick: () => removeSaved(entry),
            },
            icon('trash', 15),
          ),
        );
      }),
    );
    // The paste box takes the place of the list while it is open.
    setHidden(ui.savedList, list.length === 0 || !ui.pasteBox.hidden);
    setHidden(ui.savedEmpty, list.length > 0 || !ui.pasteBox.hidden);
  }

  function saveToMine() {
    readInputs();
    paint();
    syncInputs();
    const saved = ctx?.myTeams ?? [];
    const id = savedIdByName(saved, draft.name);
    const full = !id && saved.length >= SAVED_LIMIT;
    saveMyTeam({ ...draft, presetId: null }, id);
    actions.teamsChanged();
    if (id) say(`Updated "${draft.name}" in My teams.`, 'ok');
    else if (full) say(`Saved "${draft.name}". My teams holds ${SAVED_LIMIT}, so the oldest one made room.`, 'ok');
    else say(`Saved "${draft.name}" to My teams.`, 'ok');
  }

  function removeSaved(entry) {
    deleteMyTeam(entry.id);
    actions.teamsChanged();
    ui.saveBtn.focus({ preventScroll: true });
    say(`Deleted "${entry.team.name}" from My teams.`, 'info', {
      label: 'Undo',
      run: () => {
        saveMyTeam(entry.team, entry.id);
        actions.teamsChanged();
        say(`"${entry.team.name}" is back.`, 'ok');
      },
    });
  }

  // ---------------------------------------------------------------------------------------
  //  Import and export
  // ---------------------------------------------------------------------------------------

  function showPaste(text) {
    ui.pasteArea.value = text;
    setHidden(ui.pasteBox, false);
    setHidden(ui.savedList, true);
    setHidden(ui.savedEmpty, true);
    setAttr(ui.pasteBtn, 'aria-expanded', 'true');
    ui.pasteArea.focus({ preventScroll: true });
    if (text !== '') ui.pasteArea.select();
  }

  function hidePaste(returnFocus) {
    if (ui.pasteBox.hidden) return;
    const hadFocus = ui.pasteBox.contains(document.activeElement);
    setHidden(ui.pasteBox, true);
    ui.pasteArea.value = '';
    setAttr(ui.pasteBtn, 'aria-expanded', 'false');
    paintSaved(shownSaved ?? []);
    if (returnFocus || hadFocus) ui.pasteBtn.focus({ preventScroll: true });
  }

  /** @returns {boolean} true when the text was a team and is now in the form */
  function importText(text) {
    // Whatever the file leaves out is kept from the team being edited.
    const result = parseTeamImport(text, { fallback: draft, crests, formations: knownFormations });
    if (!result.ok) {
      say(result.error, 'error');
      return false;
    }
    setForm(result.team);
    hidePaste(false);
    const notes = result.notes.length > 0 ? ` (${result.notes.join('; ')})` : '';
    say(`Imported "${result.team.name}"${notes}. Apply to put it on the pitch.`, 'ok');
    return true;
  }

  function download() {
    readInputs();
    paint();
    const fileName = exportFileName(draft);
    try {
      const url = URL.createObjectURL(new Blob([exportTeam(draft)], { type: 'application/json' }));
      // Inside the panel: links in the switched-off page behind the modal cannot be activated.
      const link = h('a', { href: url, download: fileName, hidden: true });
      modal.panel.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      say(`Downloaded ${fileName}.`, 'ok');
    } catch {
      say('This browser would not create the file. Use Copy instead.', 'error');
    }
  }

  async function copyTeam() {
    readInputs();
    paint();
    const text = exportTeam(draft);
    if (await copyText(text)) {
      say('Copied. Send the text to a colleague: they bring it in with Paste text.', 'ok');
    } else {
      showPaste(text);
      say('Copying is blocked here. The team is selected in the box: press Ctrl+C.', 'warn');
    }
  }

  // ---------------------------------------------------------------------------------------
  //  Apply, reset, close
  // ---------------------------------------------------------------------------------------

  function resetToPreset() {
    const preset = presetById(presets, baseIds[team]);
    if (!preset) return;
    setForm(preset);
    say(`Back to ${preset.name}. Apply to put it on the pitch.`, 'info');
  }

  async function apply() {
    if (!ui || busy || ui.applyBtn.disabled) return;
    readInputs();
    paint();
    syncInputs();
    const side = team;
    const sent = draft;
    busy = true;
    paintButtons();
    say('Sending to the room', 'info');
    let outcome;
    try {
      outcome = await actions.applyTeam(side, sent);
    } catch {
      outcome = { status: 'offline', changed: [], accepted: null };
    }
    busy = false;

    if (!modal.isOpen || team !== side) {
      // The editor was closed while the answer was on its way: only bad news is worth a notice.
      if (outcome.status === 'refused') toast(`${sent.name} was not applied: the server kept the old team.`, { kind: 'warn' });
      return;
    }

    if (outcome.status === 'accepted') {
      const swapped = ctx?.room?.teams?.[side]?.kit?.swapped === true;
      modal.close();
      toast(swapped ? `${sent.name} is set. The kit was changed to avoid a clash.` : `${sent.name} is set.`, { kind: 'ok' });
      return;
    }
    if (outcome.status === 'adjusted' && outcome.accepted) {
      loadTeam(outcome.accepted);
      say(`The server adjusted the ${listNames(outcome.changed, 3)}. This is what it accepted.`, 'warn');
      flashParts(outcome.changed);
      regainFocus();
      return;
    }
    if (outcome.status === 'refused') {
      say('The server kept the old team. You may no longer be allowed to change it.', 'error');
    } else if (outcome.status === 'offline') {
      say('Not connected right now. Try again in a moment.', 'error');
    } else {
      say('', 'info');
    }
    paintButtons();
    regainFocus();
  }

  /** Apply is disabled once the room holds this team; the focus must not be left on it (it would drop out of the dialog). */
  function regainFocus() {
    const active = document.activeElement;
    if (modal.panel.contains(active) && !active.disabled) return;
    (ui.applyBtn.disabled ? modal.panel : ui.applyBtn).focus({ preventScroll: true });
  }

  /** The room moved while the editor is open. */
  function followServer(config) {
    const next = clean(config);
    if (server && teamsEqual(next, server) && next.presetId === server.presetId) return;
    const untouched = !dirty();
    server = next;
    if (untouched) {
      // Nothing typed yet: simply show the newer team (a focused box is left alone).
      baseline = next;
      setForm(next, false);
      return;
    }
    say(`${next.name} was changed in the room while you were editing. Apply replaces it.`, 'warn', {
      label: 'Load the room version',
      run: () => {
        loadTeam(next);
        say('Loaded the team as it is in the room.', 'info');
      },
    });
  }

  function requestClose() {
    if (!modal.isOpen) return;
    readInputs();
    paint();
    const side = team;
    const kept = dirty() ? JSON.parse(JSON.stringify(form)) : null;
    const label = draft.name;
    modal.close();
    if (kept) {
      toast(`Your edits to ${label} were not applied.`, {
        action: { label: 'Keep editing', run: () => open(side, kept) },
      });
    }
  }

  /**
   * @param {number} side     0 = home, 1 = away
   * @param {?object} [edits] a form to carry on with (from "Keep editing")
   */
  function open(side, edits = null) {
    if (!ctx || modal.isOpen) return;
    const config = ctx.room.teams?.[side]?.config;
    if (!config) return;
    build();
    team = side === 1 ? 1 : 0;
    teamSize = sizeOf(ctx);
    keepers = keepersOf(ctx);
    busy = false;
    shown.crest = '';
    shown.colors = '';
    paintSide();
    paintTeamSize();
    paintKeepers();
    loadTeam(config);
    if (edits) setForm(edits);
    hidePaste(false);
    paintSaved(ctx.myTeams ?? []);
    say('', 'info');
    modal.open();
  }

  return {
    open,
    get isOpen() {
      return modal.isOpen;
    },
    /** @param {object} next  the lobby's render context (see lobby.js) */
    update(next) {
      ctx = next;
      for (let side = 0; side < 2; side++) {
        baseIds[side] = basePresetId(next.room.teams?.[side]?.config, presets, baseIds[side]);
      }
      if (!modal.isOpen) return;

      const size = sizeOf(next);
      if (size !== teamSize) {
        teamSize = size;
        paintTeamSize();
      }
      if (keepersOf(next) !== keepers) {
        keepers = keepersOf(next);
        paintKeepers();
      }
      if ((next.myTeams ?? []) !== shownSaved) paintSaved(next.myTeams ?? []);
      paintSide();
      const config = next.room.teams?.[team]?.config;
      // While an Apply is on its way the room is expected to move: apply() deals with the answer.
      if (config && !busy) followServer(config);
      readInputs();
      paint();
    },
  };
}
