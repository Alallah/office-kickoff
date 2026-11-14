// "My profile": the button in the header and the popover behind it - nickname, accent colour,
// goal celebration and the auto-switch preference. Every change goes to the room (SetProfile)
// and into the saved preferences, so the next room starts with the same choices.

import { safeColor } from '../shared/crests.js';
import { getPrefs, savePrefs } from '../shared/identity.js';
import { CELEBRATIONS, LIMITS } from '../shared/protocol.js';
import { createPopover, debounce, h, icon, setAttr, setText, setValue, throttle } from './dom.js';
import { celebrationInfo, cleanNickname, createPendingValue, initialOf } from './logic.js';
import { textOn } from './team-model.js';
import { colorInput, swatches, toggle, uniqueId } from './widgets.js';

const NAME_DELAY_MS = 450;
const COLOR_DELAY_MS = 120;

/**
 * @param {{catalog: object, actions: {setProfile: (patch: object) => boolean}}} opts
 *        `patch` is a ProfileDto with only the changed fields
 */
export function createProfile({ catalog, actions }) {
  const palette = (Array.isArray(catalog.playerColors) ? catalog.playerColors : [])
    .map((hex) => safeColor(hex, '').toLowerCase())
    .filter((hex) => hex !== '');
  const celebrationIds = Array.isArray(catalog.celebrations) && catalog.celebrations.length > 0 ? catalog.celebrations : CELEBRATIONS;

  let me = null;
  let ui = null;
  let sentName = '';
  // What the user just chose is shown until the room agrees, so a RoomState that was already on
  // its way cannot flick a control back.
  const pendingName = createPendingValue(1500);
  const pendingColor = createPendingValue();
  const pendingCelebration = createPendingValue();

  const avatar = h('span', { class: 'avatar avatar-sm', 'aria-hidden': 'true' });
  const nameEl = h('span', { class: 'profile-name' });
  const button = h('button', { class: 'btn profile-btn', type: 'button' }, avatar, nameEl, icon('chevron', 14));

  function commitName(raw) {
    const name = cleanNickname(raw);
    // An empty box is someone in the middle of retyping: the old name stays until there is a new one.
    if (name === '' || name === sentName) return;
    sentName = name;
    savePrefs({ nickname: name });
    if (actions.setProfile({ nickname: name })) pendingName.request(name, performance.now());
  }
  const sendName = debounce(commitName, NAME_DELAY_MS);

  function commitColor(hex) {
    savePrefs({ color: hex });
    if (actions.setProfile({ color: hex })) pendingColor.request(hex, performance.now());
  }
  const sendColor = throttle(commitColor, COLOR_DELAY_MS);

  function paintColor(hex) {
    if (!ui) return;
    ui.colors.set(hex);
    ui.custom.set(hex || '#888888', false);
    ui.custom.setActive(hex !== '' && !palette.includes(hex));
  }

  function paintOpen() {
    if (!ui || !me) return;
    const now = performance.now();
    setValue(ui.nick, pendingName.resolve(me.name, now));
    paintColor(pendingColor.resolve(safeColor(me.color, '').toLowerCase(), now));
    const celebration = pendingCelebration.resolve(me.celebration, now);
    for (const item of ui.celebrations) {
      const on = item.id === celebration;
      if (item.input.checked !== on) item.input.checked = on;
    }
  }

  const popover = createPopover(
    button,
    (panel) => {
      const nickId = uniqueId('nickname');
      const nick = h('input', {
        class: 'input',
        type: 'text',
        id: nickId,
        maxlength: LIMITS.nickname,
        autocomplete: 'nickname',
        spellcheck: 'false',
        'data-autofocus': '',
      });
      nick.value = me?.name ?? cleanNickname(getPrefs().nickname);
      sentName = cleanNickname(nick.value);
      nick.addEventListener('input', () => sendName(nick.value));
      nick.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendName.flush();
      });
      nick.addEventListener('blur', () => {
        sendName.flush();
        if (cleanNickname(nick.value) === '' && me) nick.value = me.name;
      });

      const colors = swatches({
        label: 'Accent colour',
        colors: palette.map((hex) => ({ hex })),
        onPick: (hex) => {
          sendColor.cancel();
          commitColor(hex);
          paintColor(hex);
        },
      });
      const custom = colorInput({
        label: 'Custom accent colour',
        onInput: (hex) => {
          colors.set(hex);
          custom.setActive(!palette.includes(hex));
          sendColor(hex);
        },
      });

      const group = uniqueId('celebration');
      const celebrations = celebrationIds.map((id) => {
        const info = celebrationInfo(id);
        const input = h('input', { type: 'radio', class: 'celeb-input', name: group, value: id });
        input.addEventListener('change', () => {
          if (!input.checked) return;
          savePrefs({ celebration: id });
          if (actions.setProfile({ celebration: id })) pendingCelebration.request(id, performance.now());
        });
        const el = h(
          'label',
          { class: 'celeb' },
          input,
          h(
            'span',
            { class: 'celeb-face' },
            h('span', { class: 'celeb-emoji', 'aria-hidden': 'true', text: info.emoji }),
            h('span', { class: 'celeb-label', text: info.label }),
          ),
        );
        return { id, input, el };
      });

      const autoSwitch = toggle({
        label: 'Auto-switch player',
        onChange: (on) => {
          savePrefs({ autoSwitch: on });
          actions.setProfile({ autoSwitch: on });
        },
      });
      // The room does not echo this one back; the saved preference is what was sent on joining.
      autoSwitch.set(getPrefs().autoSwitch !== false);

      panel.append(
        h('h3', { class: 'popover-title display', text: 'My profile' }),
        h('div', { class: 'field' }, h('label', { class: 'label', for: nickId, text: 'Nickname' }), nick),
        h('div', { class: 'field' }, h('span', { class: 'label', text: 'Accent colour' }), h('div', { class: 'swatch-row' }, colors.el, custom.el)),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'label', text: 'Goal celebration' }),
          h('div', { class: 'celebs', role: 'radiogroup', 'aria-label': 'Goal celebration' }, celebrations.map((item) => item.el)),
        ),
        h(
          'div',
          { class: 'field' },
          autoSwitch.el,
          h('p', {
            class: 'hint',
            text: 'When your team is defending, control moves to the team-mate best placed to win the ball. Q and E always switch by hand.',
          }),
        ),
      );
      ui = { nick, colors, custom, celebrations };
      paintOpen();
    },
    {
      label: 'My profile',
      align: 'end',
      className: 'profile',
      onClose: () => {
        sendName.flush();
        sendColor.flush();
        ui = null;
      },
    },
  );

  return {
    /** The header button that opens the popover. */
    button,
    open() {
      popover.open();
    },
    /** @param {object} ctx  the lobby's render context (see lobby.js) */
    update(ctx) {
      me = ctx.view.me;
      if (!me) return;
      const color = safeColor(me.color, '#a9b6d6');
      avatar.style.setProperty('--c', color);
      avatar.style.setProperty('--ink', textOn(color));
      setText(avatar, initialOf(me.name));
      setText(nameEl, me.name);
      setAttr(button, 'aria-label', `My profile: ${me.name}`);
      setAttr(button, 'title', 'Nickname, colour and celebration');
      paintOpen();
    },
  };
}
