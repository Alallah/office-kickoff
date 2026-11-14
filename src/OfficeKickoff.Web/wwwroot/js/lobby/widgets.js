// Small form controls shared by the settings panel, the profile popover and the team editor.
// Each is a native input underneath (checkbox, radio, range, color), so keyboard use, focus and
// the disabled state of an enclosing <fieldset> all work without extra code.

import { safeColor } from '../shared/crests.js';
import { h, hasFocus, setText } from './dom.js';

let counter = 0;

/** A document-unique id / name for wiring labels to controls. */
export function uniqueId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

/**
 * An on/off switch.
 * @param {{label: string, title?: string, onChange: (on: boolean) => void}} opts
 */
export function toggle({ label, title, onChange }) {
  const input = h('input', { type: 'checkbox', class: 'switch-input' });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h(
    'label',
    { class: 'switch', title },
    input,
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
    h('span', { class: 'switch-text', text: label }),
  );
  return {
    el,
    input,
    set(on) {
      if (input.checked !== on) input.checked = on;
    },
  };
}

/**
 * A row of mutually exclusive choices (radio buttons drawn as one segmented bar).
 * @param {{label: string, options: Array<{value: *, label: string, title?: string}>, onChange: (value: *) => void}} opts
 */
export function segmented({ label, options, onChange }) {
  const name = uniqueId('seg');
  const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  let items = [];

  function setOptions(list) {
    el.replaceChildren();
    items = list.map((option) => {
      const input = h('input', { type: 'radio', class: 'seg-input', name, value: String(option.value) });
      input.addEventListener('change', () => {
        if (input.checked) onChange(option.value);
      });
      el.appendChild(h('label', { class: 'seg-item', title: option.title }, input, h('span', { class: 'seg-text', text: option.label })));
      return { input, value: option.value };
    });
  }

  setOptions(options);
  return {
    el,
    setOptions,
    set(value) {
      for (const item of items) {
        const on = item.value === value;
        if (item.input.checked !== on) item.input.checked = on;
      }
    },
  };
}

/**
 * A range slider with its value written next to it.
 * @param {{label: string, min: number, max: number, step: number, format: (value: number) => string, onInput: (value: number) => void}} opts
 */
export function slider({ label, min, max, step, format, onInput }) {
  const id = uniqueId('range');
  const input = h('input', { type: 'range', class: 'range', id, min, max, step, 'aria-label': label });
  const output = h('output', { class: 'range-value tnum', for: id });
  input.addEventListener('input', () => onInput(Number(input.value)));
  const el = h('div', { class: 'range-wrap' }, input, output);
  return {
    el,
    input,
    set(value) {
      const text = String(value);
      if (input.value !== text) input.value = text;
      // The filled part of the track is painted from this custom property (see .range in site.css).
      const share = max > min ? ((value - min) / (max - min)) * 100 : 0;
      input.style.setProperty('--fill', `${Math.min(100, Math.max(0, share)).toFixed(1)}%`);
      setText(output, format(value));
      input.setAttribute('aria-valuetext', format(value));
    },
  };
}

/**
 * A row of colour swatches (radio buttons, so the arrow keys move between them).
 * @param {{label: string, colors: Array<{hex: string, name?: string}>, onPick: (hex: string) => void}} opts
 *        Entries that are not "#rrggbb" are left out.
 */
export function swatches({ label, colors, onPick }) {
  const name = uniqueId('swatch');
  const items = [];
  for (const color of colors) {
    const hex = safeColor(color?.hex, '').toLowerCase();
    if (hex === '') continue;
    const title = color.name || hex;
    const input = h('input', { type: 'radio', class: 'swatch-input', name, value: hex, 'aria-label': title });
    input.addEventListener('change', () => {
      if (input.checked) onPick(hex);
    });
    const dot = h('span', { class: 'swatch-dot', style: { '--c': hex }, 'aria-hidden': 'true' });
    items.push({ input, hex, el: h('label', { class: 'swatch', title }, input, dot) });
  }
  const el = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': label }, items.map((item) => item.el));
  return {
    el,
    /** Marks the swatch of this colour, or none when the colour is not one of them. */
    set(hex) {
      const wanted = String(hex ?? '').toLowerCase();
      for (const item of items) {
        const on = item.hex === wanted;
        if (item.input.checked !== on) item.input.checked = on;
      }
    },
  };
}

/**
 * A free colour picker drawn as a round chip; the native <input type="color"> lies invisibly on
 * top of it, so a click or Enter opens the system picker.
 * @param {{label: string, onInput: (hex: string) => void}} opts
 */
export function colorInput({ label, onInput }) {
  const input = h('input', { type: 'color', class: 'color-input', 'aria-label': label });
  const chip = h('span', { class: 'color-chip', 'aria-hidden': 'true' });
  input.addEventListener('input', () => {
    chip.style.setProperty('--c', input.value);
    onInput(input.value.toLowerCase());
  });
  const el = h('label', { class: 'color-pick', title: label }, input, chip);
  return {
    el,
    input,
    /** Shows a colour. With `force` false it is left alone while the picker is in use. */
    set(hex, force = true) {
      const value = safeColor(hex, '#888888').toLowerCase();
      if (!force && hasFocus(input)) return;
      if (input.value !== value) input.value = value;
      chip.style.setProperty('--c', value);
    },
    /** Marks the chip as holding the current colour (when no swatch does). */
    setActive(on) {
      el.classList.toggle('is-active', on);
    },
  };
}
