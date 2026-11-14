// The mini pitch: one team's half seen from above, its formation drawn as numbered shirts with
// the roster names underneath. Used on the team cards and in the editor's live preview.
//
// It is plain HTML rather than SVG so that it can take any size the layout gives it while the
// shirts and the lettering stay the same size; the turf and its markings are CSS (.pitch).

import { LIMITS } from '../shared/protocol.js';
import { h, setAttr, setClass, setHidden, setText } from './dom.js';
import { lineup, pitchPoint, shortName, textOn } from './team-model.js';

/**
 * @param {{flip?: boolean}} [opts]  flip = the away side: goal on the right, attacking leftwards
 */
export function createMiniPitch({ flip = false } = {}) {
  const el = h(
    'div',
    { class: `pitch${flip ? ' pitch-flip' : ''}`, role: 'img' },
    h('span', { class: 'pitch-goal', 'aria-hidden': 'true' }),
    h('span', { class: 'pitch-box', 'aria-hidden': 'true' }),
    h('span', { class: 'pitch-arc', 'aria-hidden': 'true' }),
  );

  // One shirt per roster slot, created once: moving them (instead of rebuilding) is what lets a
  // change of formation glide.
  const shirts = [];
  for (let slot = 0; slot < LIMITS.rosterSize; slot++) {
    const number = h('span', { class: 'shirt-number tnum' });
    const name = h('span', { class: 'shirt-name' });
    const shirt = h('div', { class: 'shirt', hidden: true, 'aria-hidden': 'true' }, number, name);
    el.appendChild(shirt);
    shirts.push({ el: shirt, number, name, shown: false });
  }

  return {
    el,
    /**
     * @param {{formation: string, teamSize: number, keepers?: boolean, roster: Array<{name: string, number: number}>,
     *          kit: {primary: string, secondary: string, keeper: string, text: string}}} model
     *        `formation` must already be valid for the team size (TeamDto.formation or resolveFormation).
     *        `keepers` is MatchSettingsDto.keepers: false draws slot 0 as an ordinary footballer.
     */
    update({ formation, teamSize, keepers = true, roster, kit }) {
      el.style.setProperty('--shirt', kit.primary);
      el.style.setProperty('--trim', kit.secondary);
      el.style.setProperty('--ink', kit.text);
      el.style.setProperty('--keeper', kit.keeper);
      el.style.setProperty('--keeper-ink', textOn(kit.keeper));

      const spots = lineup(formation, teamSize, keepers);
      const said = [];
      shirts.forEach((shirt, slot) => {
        const spot = spots[slot];
        if (!spot) {
          setHidden(shirt.el, true);
          shirt.shown = false;
          return;
        }
        const entry = roster?.[slot] ?? {};
        const point = pitchPoint(spot, flip);
        setClass(shirt.el, 'shirt-keeper', spot.keeper);
        shirt.el.style.left = `${point.left.toFixed(2)}%`;
        shirt.el.style.top = `${point.top.toFixed(2)}%`;
        setText(shirt.number, entry.number ?? '');
        setText(shirt.name, shortName(entry.name));
        setAttr(shirt.el, 'title', `${entry.number ?? ''} ${entry.name ?? ''}`.trim());
        if (!shirt.shown) {
          setHidden(shirt.el, false);
          shirt.shown = true;
        }
        said.push(`${spot.keeper ? 'goalkeeper ' : ''}${entry.number ?? ''} ${entry.name ?? ''}`.trim());
      });
      setAttr(el, 'aria-label', `Formation ${formation}: ${said.join(', ')}`);
    },
  };
}
