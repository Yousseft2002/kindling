/* The sealed envelope, as a screen.
 *
 * Sending: an open envelope with the letter standing in it. Write a line,
 * choose whether it stays a surprise, and the letter sinks back, the flap
 * closes and a wax seal presses down. Then the link goes out through the
 * phone's own share sheet.
 *
 * Receiving: the same envelope, sealed. Touching the seal breaks it, the flap
 * lifts and the letter rises - and only then does the evening open.
 *
 * All of it runs on springTo, which already carries a deadline and honours
 * reduced motion: with motion off the envelope simply arrives in its final
 * state. Nothing here waits on an animation that a hidden tab would freeze.
 */

import { springTo } from './spring.js';
import { seal as packEvening, linkFor } from '../lib/envelope.js';
import { invitationSummary } from '../lib/ideas.js';

const DEFAULT_SAY = 'You, me, and a night to see where it goes.';
const FLAME = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">'
  + '<path fill="currentColor" d="M12 2c1 3.6 5.2 5.6 5.2 10.2a5.2 5.2 0 0 1-10.4 0c0-2.1 1-3.4 2.1-4.4.2 1.7.9 2.5 1.7 2.8C10.3 8.3 10.8 4.6 12 2z"/></svg>';

const envelope = (seal, sealed) => `
  <div class="ev-env${sealed ? ' sealed' : ''}">
    <div class="ev-back"></div>
    <div class="ev-letter"><p class="ev-hi">For you</p><p class="ev-say"></p></div>
    <div class="ev-front"></div>
    <div class="ev-flap"></div>
    ${seal}
  </div>`;

function mount(label) {
  const ev = document.createElement('div');
  ev.className = 'ev';
  ev.setAttribute('role', 'dialog');
  ev.setAttribute('aria-modal', 'true');
  ev.setAttribute('aria-label', label);
  document.body.appendChild(ev);
  document.documentElement.classList.add('locked');
  let closed = false;
  return {
    ev,
    // A reflow rather than requestAnimationFrame: a page that is not being
    // painted never runs rAF, and the overlay would open transparent.
    show() { void ev.offsetWidth; ev.classList.add('on'); },
    close() {
      if (closed) return;
      closed = true;
      ev.classList.add('leaving');
      document.documentElement.classList.remove('locked');
      setTimeout(() => ev.remove(), 400);
    },
  };
}

const raise = env => Math.round(env.offsetHeight * 0.6);

/** Flap up, then the letter rises out of the pocket. */
async function unfold(env) {
  await springTo(env.querySelector('.ev-flap'), { rotateX: 0 }, { rotateX: 180 }, { tension: 130, friction: 16 });
  // Now clear of the letter, the flap can drop behind it.
  env.classList.add('open');
  await springTo(env.querySelector('.ev-letter'), { y: 0 }, { y: -raise(env) }, { tension: 150, friction: 17 });
}

/** The reverse: the letter sinks, the flap comes down, the wax presses on. */
async function sealUp(env) {
  await springTo(env.querySelector('.ev-letter'), { y: -raise(env) }, { y: 0 }, { tension: 170, friction: 20 });
  env.classList.remove('open');
  await springTo(env.querySelector('.ev-flap'), { rotateX: 180 }, { rotateX: 0 }, { tension: 140, friction: 18 });
  await springTo(env.querySelector('.ev-seal'), { scale: 1.9, opacity: 0 }, { scale: 1, opacity: 1 },
                 { tension: 260, friction: 14 });
}

/* ---- sending -------------------------------------------------------------- */

/** `data` is the plan on screen: { plan, prefs, weather }. */
export function openSeal({ data }) {
  const m = mount('Seal this evening');
  const { ev } = m;
  ev.innerHTML = `
    <div class="ev-col">
      ${envelope(`<span class="ev-seal" aria-hidden="true">${FLAME}</span>`, false)}
      <div class="ev-panel card">
        <div id="ev_write">
          <label class="lbl" for="ev_note">A line for them <small>optional</small></label>
          <textarea id="ev_note" maxlength="140" rows="2" placeholder="Wear something you can dance in."></textarea>
          <div class="tags pick" style="margin-top:12px">
            <button type="button" class="tag" id="ev_surprise" aria-pressed="false">Keep it a surprise</button>
          </div>
          <p class="detail" style="margin:8px 0 0">The envelope will not say what is inside until they break the seal.</p>
          <button class="cta wide" type="button" id="ev_seal">Seal it</button>
          <button class="btn ghost ev-wide" type="button" id="ev_cancel">Not yet</button>
        </div>
        <div id="ev_sealed" hidden>
          <h3 class="ev-title" tabindex="-1">Sealed.</h3>
          <p class="detail" style="margin:8px 0 0">Anyone with the link can open it, so send it straight to them.</p>
          <button class="cta wide" type="button" id="ev_send">Send it</button>
          <button class="btn ghost ev-wide" type="button" id="ev_copy">Copy link</button>
          <input id="ev_link" class="ev-link" readonly hidden aria-label="Link to copy">
          <button class="btn ghost ev-wide" type="button" id="ev_done">Done</button>
        </div>
        <p class="ev-status" id="ev_status" role="status" aria-live="polite"></p>
      </div>
    </div>`;

  const $ = s => ev.querySelector(s);
  const env = $('.ev-env'), note = $('#ev_note'), tag = $('#ev_surprise'), say = $('.ev-say');
  const status = msg => { $('#ev_status').textContent = msg; };
  const paint = () => { say.textContent = invitationSummary(data.plan, data.prefs); };
  paint();
  note.addEventListener('input', paint);
  tag.addEventListener('click', () => tag.setAttribute('aria-pressed', String(tag.getAttribute('aria-pressed') !== 'true')));

  const onKey = e => { if (e.key === 'Escape') leave(); };
  const leave = () => { document.removeEventListener('keydown', onKey); m.close(); };
  document.addEventListener('keydown', onKey);
  $('#ev_cancel').addEventListener('click', leave);
  $('#ev_done').addEventListener('click', leave);

  let link = '', busy = false;
  $('#ev_seal').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    let token;
    try {
      token = await packEvening(data, { note: note.value, surprise: tag.getAttribute('aria-pressed') === 'true' });
    } catch {
      status('This evening could not be sealed. Plan it again and retry.');
      busy = false;
      return;
    }
    link = linkFor(token, location.origin + location.pathname);
    $('#ev_write').querySelectorAll('textarea,button').forEach(el => { el.disabled = true; });
    await sealUp(env);
    $('#ev_write').hidden = true;
    $('#ev_sealed').hidden = false;
    $('#ev_sealed .ev-title').focus();
  });

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); status('Link copied.'); }
    catch {
      // No clipboard here: leave the link selected, ready to copy by hand.
      const box = $('#ev_link');
      box.value = link; box.hidden = false; box.select();
      status('Copy the link from the box.');
    }
  };
  $('#ev_copy').addEventListener('click', copy);
  $('#ev_send').addEventListener('click', async () => {
    const payload = { title: 'A sealed evening', url: link,
                      text: 'I planned something for you. Break the seal when you are ready.' };
    if (navigator.share && (!navigator.canShare || navigator.canShare(payload))) {
      try { await navigator.share(payload); return; }
      catch (err) { if (err?.name === 'AbortError') return; }
    }
    copy();
  });

  m.show();
  note.focus({ preventScroll: true });
  unfold(env);
}

/* ---- receiving ------------------------------------------------------------ */

/** `{ note, surprise, data }` as unsealed by lib/envelope.js. `onOpen` runs
 *  when they choose to see the evening. */
export function openReceived({ note, surprise, data, onOpen }) {
  const m = mount('A sealed evening');
  const { ev } = m;
  ev.innerHTML = `
    <div class="ev-col">
      ${envelope(`<button class="ev-seal ev-ping" type="button" aria-label="Break the seal">${FLAME}</button>`, true)}
      <div class="ev-text">
        <p class="eyebrow ev-eyebrow">Sealed for you</p>
        <h2 class="ev-title"></h2>
        <p class="ev-sub"></p>
      </div>
      <p class="ev-hint">Tap the seal</p>
      <button class="cta wide" type="button" id="ev_go" hidden>See the evening</button>
    </div>`;

  const $ = s => ev.querySelector(s);
  const env = $('.ev-env'), seal = $('.ev-seal'), go = $('#ev_go');
  $('.ev-title').textContent = surprise ? 'Something is planned for you.'
    : invitationSummary(data.plan, data.prefs);
  $('.ev-sub').textContent = surprise ? 'Break the seal to see what.'
    : 'Keep the night open.';
  $('.ev-say').textContent = note || DEFAULT_SAY;

  let opened = false;
  seal.addEventListener('click', async () => {
    if (opened) return;
    opened = true;
    seal.classList.remove('ev-ping');
    $('.ev-hint').hidden = true;
    await springTo(seal, { scale: 1, opacity: 1 }, { scale: 1.4, opacity: 0 }, { tension: 300, friction: 22 });
    seal.hidden = true;
    await unfold(env);
    go.hidden = false;
    springTo(go, { y: 14, opacity: 0 }, { y: 0, opacity: 1 });
    go.focus({ preventScroll: true });
  });
  go.addEventListener('click', () => { m.close(); onOpen(); });

  m.show();
  seal.focus({ preventScroll: true });
}
