// One team's card: crest, name and code, the kit it will actually wear, its formation on a mini
// pitch, the two human seats, and - for the host and the team's own players - the controls that
// change the team.

import { crestSvg, safeColor } from '../shared/crests.js';
import { createPopover, h, icon, replay, setAttr, setClass, setHidden, setText } from './dom.js';
import { SEATS_PER_TEAM, seatModel } from './logic.js';
import { createMiniPitch } from './pitch.js';
import { kitOf, lastTeamOfferFor, matchPreset, resolveFormation, sanitizeTeam, textOn } from './team-model.js';

function kitChip(label) {
  const dot = h('i', { class: 'kit-dot', 'aria-hidden': 'true' });
  const el = h('span', { class: 'kit-chip' }, dot, h('span', { text: label }));
  return {
    el,
    set(color) {
      dot.style.setProperty('--c', color);
      setAttr(el, 'title', `${label}: ${color}`);
    },
  };
}

function setClassName(node, value) {
  if (node.className !== value) node.className = value;
}

/**
 * @param {{team: 0|1, catalog: object, actions: {setTeam: (team: number) => void,
 *          editTeam: (team: number) => void, pickTeam: (team: number, config: object) => void}}} opts
 */
export function createTeamCard({ team, catalog, actions }) {
  const side = team === 0 ? 'home' : 'away';
  const presets = Array.isArray(catalog.teamPresets) ? catalog.teamPresets.filter((p) => p && typeof p.name === 'string') : [];
  let last = null;
  let shownCrest = null;

  // ---- identity ---------------------------------------------------------------------------
  const crest = h('div', { class: 'team-crest', 'aria-hidden': 'true' });
  const name = h('h2', { class: 'team-name display', id: `team-${team}-name` });
  const code = h('span', { class: 'team-code display', title: 'Scoreboard code' });
  const head = h(
    'header',
    { class: 'team-head' },
    crest,
    h('div', { class: 'team-title' }, h('span', { class: 'label team-side', text: team === 0 ? 'Home' : 'Away' }), name),
    code,
  );

  // ---- kit --------------------------------------------------------------------------------
  const kitShirt = kitChip('Shirt');
  const kitTrim = kitChip('Trim');
  const kitKeeper = kitChip('Keeper');
  const kitNote = h('span', { class: 'kit-note', hidden: true }, icon('warning', 13), h('span', { text: 'changed to avoid a clash' }));
  const formationValue = h('strong', { class: 'tnum' });
  const kitRow = h(
    'div',
    { class: 'team-kit' },
    kitShirt.el,
    kitTrim.el,
    kitKeeper.el,
    kitNote,
    h('span', { class: 'team-formation' }, h('span', { class: 'label', text: 'Formation' }), formationValue),
  );

  const pitch = createMiniPitch({ flip: team === 1 });

  // ---- seats ------------------------------------------------------------------------------
  const seatList = h('ul', { class: 'seats' });
  const seats = [];

  function createSeat() {
    const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
    const who = h('span', { class: 'seat-name' });
    const crown = h('span', { class: 'seat-crown', title: 'Host', hidden: true }, icon('crown', 15), h('span', { class: 'sr-only', text: 'Host' }));
    const you = h('span', { class: 'tag tag-you', text: 'You', hidden: true });
    const status = h('span', { class: 'seat-status' });
    const ping = h('span', { class: 'seat-ping tnum' });
    const person = h(
      'div',
      { class: 'seat-person', hidden: true },
      avatar,
      h('div', { class: 'seat-text' }, h('div', { class: 'seat-line' }, who, crown, you), h('div', { class: 'seat-line seat-sub' }, status, ping)),
    );

    const join = h(
      'button',
      { class: 'seat-join', type: 'button', hidden: true, onClick: () => actions.setTeam(team) },
      h('span', { class: 'seat-glyph', 'aria-hidden': 'true' }, icon('plus', 18)),
      h('span', { class: 'seat-text' }, h('strong', { text: 'Join' }), h('small', { text: 'AI plays here until someone does' })),
    );
    const open = h(
      'div',
      { class: 'seat-open', hidden: true },
      h('span', { class: 'seat-glyph', 'aria-hidden': 'true' }, icon('bot', 18)),
      h('span', { class: 'seat-text' }, h('strong', { text: 'Open seat' }), h('small', { text: 'The AI fills in' })),
    );
    const el = h('li', { class: 'seat' }, person, join, open);

    return {
      el,
      /**
       * @param {?object} member  MemberDto, or null for an empty seat
       * @param {{memberId: number, hostId: number, canJoin: boolean, bounce: boolean, teamName: string}} o
       */
      update(member, o) {
        if (member) {
          const m = seatModel(member, o.memberId, o.hostId);
          const color = safeColor(member.color, '#a9b6d6');
          avatar.style.setProperty('--c', color);
          avatar.style.setProperty('--ink', textOn(color));
          setText(avatar, m.initial);
          setText(who, m.name);
          setAttr(who, 'title', m.name);
          setHidden(crown, !m.isHost);
          setHidden(you, !m.isMe);
          setText(status, m.status);
          setClassName(status, `seat-status tone-${m.tone}`);
          setText(ping, m.pingText);
          setClassName(ping, `seat-ping tnum ping-${m.pingTone}`);
          setClass(el, 'is-me', m.isMe);
          setClass(el, 'is-away', !m.connected);
          setClass(el, 'is-ready', m.tone === 'ready');
        } else {
          setClass(el, 'is-me', false);
          setClass(el, 'is-away', false);
          setClass(el, 'is-ready', false);
          setAttr(join, 'aria-label', `Join ${o.teamName}`);
        }
        setClass(el, 'is-empty', !member);
        setHidden(person, !member);
        setHidden(join, Boolean(member) || !o.canJoin);
        setHidden(open, Boolean(member) || o.canJoin);
        if (o.bounce) replay(el, 'is-bounce');
      },
    };
  }

  // ---- controls ---------------------------------------------------------------------------
  const changeBtn = h('button', { class: 'btn btn-sm', type: 'button' }, icon('shirt', 15), h('span', { text: 'Change team' }), icon('chevron', 14));
  const editBtn = h(
    'button',
    { class: 'btn btn-sm', type: 'button', onClick: () => actions.editTeam(team) },
    icon('pencil', 15),
    h('span', { text: 'Edit team' }),
  );
  const lastLabel = h('span');
  const lastBtn = h(
    'button',
    {
      class: 'btn btn-sm btn-offer',
      type: 'button',
      hidden: true,
      onClick: () => {
        if (last?.lastTeam) actions.pickTeam(team, last.lastTeam);
      },
    },
    icon('undo', 15),
    lastLabel,
  );
  const lock = h('p', { class: 'team-lock', hidden: true, text: "Only the host and this team's players can change it" });
  const controls = h('div', { class: 'team-controls' }, changeBtn, editBtn, lastBtn, lock);

  function pickerItem(config, { current, taken, onPick }) {
    const art = h('span', { class: 'picker-crest', 'aria-hidden': 'true' });
    art.innerHTML = crestSvg(config.crest, config.primary, config.secondary, { size: 30 });
    const note = current ? 'Playing now' : taken ? 'On the other side' : config.code;
    return h(
      'button',
      {
        class: `picker-item${current ? ' is-current' : ''}`,
        type: 'button',
        disabled: taken,
        'aria-pressed': current ? 'true' : 'false',
        'data-autofocus': current ? '' : null,
        onClick: onPick,
      },
      art,
      h('span', { class: 'picker-text' }, h('strong', { text: config.name }), h('small', { text: note })),
    );
  }

  const picker = createPopover(
    changeBtn,
    (panel, close) => {
      const mine = last?.room?.teams?.[team]?.config;
      const theirs = last?.room?.teams?.[1 - team]?.config;
      const current = matchPreset(mine, presets);
      const taken = matchPreset(theirs, presets);
      const pick = (config) => {
        close();
        actions.pickTeam(team, config);
      };
      const saved = last?.myTeams ?? [];
      panel.append(
        h('h3', { class: 'popover-title display', text: 'Pick a team' }),
        h(
          'div',
          { class: 'picker-grid' },
          presets.map((preset) => {
            const config = sanitizeTeam(preset, { crests: catalog.crests });
            return pickerItem(config, { current: preset === current, taken: preset === taken, onPick: () => pick(config) });
          }),
        ),
        h('h3', { class: 'popover-title display', text: 'My teams' }),
        saved.length > 0
          ? h(
              'div',
              { class: 'picker-grid' },
              saved.map((entry) => pickerItem(entry.team, { current: false, taken: false, onPick: () => pick(entry.team) })),
            )
          : h('p', { class: 'hint', text: 'Teams you save in the editor show up here, on this computer.' }),
      );
    },
    { label: `Pick a team for the ${side} side`, className: 'picker', align: team === 0 ? 'start' : 'end' },
  );

  const el = h(
    'section',
    { class: `team-card team-${side} panel`, 'aria-labelledby': `team-${team}-name` },
    head,
    kitRow,
    pitch.el,
    seatList,
    controls,
  );

  return {
    el,
    /** True while the "Change team" list is open (the page leaves it alone meanwhile). */
    get pickerOpen() {
      return picker.isOpen;
    },
    /** @param {object} ctx  the lobby's render context (see lobby.js) */
    update(ctx) {
      last = ctx;
      const dto = ctx.room.teams?.[team];
      const config = dto?.config;
      if (!config) return;
      const kit = kitOf(dto);
      const teamSize = ctx.room.settings?.teamSize ?? 5;
      const formation = resolveFormation(dto.formation, teamSize, catalog.formations);

      const crestKey = `${config.crest}|${config.primary}|${config.secondary}`;
      if (crestKey !== shownCrest) {
        crest.innerHTML = crestSvg(config.crest, config.primary, config.secondary, { size: 60 });
        if (shownCrest !== null) replay(crest, 'is-pop');
        shownCrest = crestKey;
      }
      setText(name, config.name);
      setAttr(name, 'title', config.name);
      setText(code, config.code);

      el.style.setProperty('--kit', kit.primary);
      el.style.setProperty('--kit-2', kit.secondary);
      el.style.setProperty('--kit-ink', kit.text);
      kitShirt.set(kit.primary);
      kitTrim.set(kit.secondary);
      kitKeeper.set(kit.keeper);
      setHidden(kitNote, !kit.swapped);
      setText(formationValue, formation);
      pitch.update({ formation, teamSize, roster: config.roster, kit });

      const list = ctx.view.seats[team] ?? [];
      const count = Math.max(SEATS_PER_TEAM, list.length);
      while (seats.length < count) {
        const seat = createSeat();
        seats.push(seat);
        seatList.appendChild(seat.el);
      }
      const canJoin = ctx.view.myTeam !== team && !ctx.view.teamFull[team];
      seats.forEach((seat, i) => {
        setHidden(seat.el, i >= count);
        if (i >= count) return;
        seat.update(list[i] ?? null, {
          memberId: ctx.memberId,
          hostId: ctx.room.hostId,
          canJoin,
          bounce: ctx.bounced.has(`${team}:${i}`),
          teamName: config.name,
        });
      });
      setAttr(seatList, 'aria-label', `Players of ${config.name}`);

      const canEdit = ctx.view.canEdit[team];
      setHidden(changeBtn, !canEdit);
      setHidden(editBtn, !canEdit);
      setHidden(lock, canEdit);
      if (!canEdit && picker.isOpen) picker.close();
      const offer = canEdit && lastTeamOfferFor(ctx.room, ctx.view.myTeam, presets, ctx.lastTeam) === team;
      setHidden(lastBtn, !offer);
      if (offer) setText(lastLabel, `Use my last team: ${sanitizeTeam(ctx.lastTeam).name}`);
    },
  };
}
