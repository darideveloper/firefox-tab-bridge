import { describe, expect, test } from 'bun:test';
import '../extension/core.js';

const C = (globalThis as any).FFBCore;

function makeElement(props: any = {}) {
  const attrs = props.attrs || {};
  return {
    nodeType: 1,
    tagName: props.tagName || 'DIV',
    type: props.type,
    value: props.value,
    textContent: props.text || '',
    isContentEditable: !!props.contentEditable,
    disabled: !!props.disabled,
    checked: !!props.checked,
    labels: props.labels,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => props.style || { display: 'block', visibility: 'visible', opacity: '1' },
      },
      getElementById: () => null,
      querySelector: () => null,
    },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    getClientRects() {
      return props.hidden ? [] : [{ width: 10, height: 10 }];
    },
  };
}

describe('roleOf', () => {
  test('maps native tags and input types', () => {
    expect(C.roleOf(makeElement({ tagName: 'BUTTON' }))).toBe('button');
    expect(C.roleOf(makeElement({ tagName: 'A' }))).toBe('link');
    expect(C.roleOf(makeElement({ tagName: 'INPUT', type: 'checkbox' }))).toBe('checkbox');
    expect(C.roleOf(makeElement({ tagName: 'INPUT', type: 'hidden' }))).toBe(null);
    expect(C.roleOf(makeElement({ tagName: 'INPUT', type: 'text' }))).toBe('textbox');
    expect(C.roleOf(makeElement({ tagName: 'SELECT' }))).toBe('combobox');
    expect(C.roleOf(makeElement({ tagName: 'H2' }))).toBe('heading');
  });

  test('an explicit role wins and plain divs have none', () => {
    expect(C.roleOf(makeElement({ tagName: 'DIV', attrs: { role: 'tab' } }))).toBe('tab');
    expect(C.roleOf(makeElement({ tagName: 'DIV' }))).toBe(null);
  });
});

describe('nameOf', () => {
  test('prefers aria-label, then label text, then text content', () => {
    expect(C.nameOf(makeElement({ tagName: 'INPUT', attrs: { 'aria-label': 'Search' } }))).toBe('Search');
    expect(
      C.nameOf(makeElement({ tagName: 'INPUT', labels: [{ textContent: 'Email' }] }))
    ).toBe('Email');
    expect(C.nameOf(makeElement({ tagName: 'BUTTON', text: '  Sign   in ' }))).toBe('Sign in');
  });

  test('truncates long names', () => {
    const name = C.nameOf(makeElement({ tagName: 'BUTTON', text: 'x'.repeat(200) }));
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('describe', () => {
  test('builds a snapshot line with value and state', () => {
    const line = C.describe(
      makeElement({ tagName: 'INPUT', type: 'text', value: 'a@b.c', attrs: { placeholder: 'Email' }, disabled: true }),
      'e4'
    );
    expect(line).toContain('e4 textbox');
    expect(line).toContain('"Email"');
    expect(line).toContain('value="a@b.c"');
    expect(line).toContain('disabled');
  });

  test('masks password values', () => {
    const line = C.describe(makeElement({ tagName: 'INPUT', type: 'password', value: 'hunter2' }), 'e1');
    expect(line).not.toContain('hunter2');
    expect(line).toContain('••••');
  });
});

describe('visibility and candidates', () => {
  test('hidden elements are skipped', () => {
    expect(C.isVisible(makeElement({ hidden: true }))).toBe(false);
    expect(C.isVisible(makeElement({ style: { display: 'none', visibility: 'visible', opacity: '1' } }))).toBe(false);
    expect(C.isVisible(makeElement({ style: { display: 'block', visibility: 'hidden', opacity: '1' } }))).toBe(false);
    expect(C.isVisible(makeElement())).toBe(true);
  });

  test('candidate filter keeps controls and drops chrome', () => {
    expect(C.isCandidate(makeElement({ tagName: 'BUTTON' }))).toBe(true);
    expect(C.isCandidate(makeElement({ tagName: 'SCRIPT' }))).toBe(false);
    expect(C.isCandidate(makeElement({ tagName: 'DIV' }))).toBe(false);
    expect(C.isCandidate(makeElement({ tagName: 'DIV', attrs: { tabindex: '0' } }))).toBe(true);
  });
});

describe('capLines', () => {
  test('caps the snapshot and reports the remainder', () => {
    const capped = C.capLines(['a', 'b', 'c'], 2);
    expect(capped.lines).toEqual(['a', 'b']);
    expect(capped.truncated).toBe(1);
    const whole = C.capLines(['a'], 2);
    expect(whole.truncated).toBe(0);
  });
});
