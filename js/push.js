// Turning on real phone notifications, from the portal and the manager alike.
//
// The awkward part is iPhone. Safari will not even define PushManager in a
// normal tab — the site has to be on the Home Screen first (iOS 16.4+). So
// rather than offering a button that silently does nothing, this detects that
// case and says exactly what to do instead.
(function () {
  var API = '/api/push';

  function b64ToU8(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function isiOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent); }
  function standalone() {
    return !!(window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches);
  }
  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }
  // A phone that can do this but has not been set up for it yet.
  function needsHomeScreen() { return isiOS() && !standalone() && !supported(); }

  function deviceLabel() {
    var ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows PC';
    return 'This device';
  }

  async function call(action, auth, extra) {
    var body = Object.assign({ action: action }, auth || {}, extra || {});
    var headers = { 'Content-Type': 'application/json' };
    if (auth && auth.pass) headers['x-ceo-password'] = auth.pass;
    var r = await fetch(API, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }

  // Signs this phone up. Returns the number of devices now listening.
  async function enable(auth) {
    if (!supported()) throw new Error('unsupported');
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('denied');

    var reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    var keyRes = await fetch(API + '?action=key').then(function (r) { return r.json(); });
    if (!keyRes.key) throw new Error('The studio has no push keys yet — try again in a moment.');

    var sub = await reg.pushManager.getSubscription();
    // A subscription made against a different key can never be delivered to,
    // so replace it rather than saving something dead.
    if (sub) {
      var same = sub.options && sub.options.applicationServerKey &&
        btoa(String.fromCharCode.apply(null, new Uint8Array(sub.options.applicationServerKey)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === keyRes.key;
      if (!same) { try { await sub.unsubscribe(); } catch (e) {} sub = null; }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToU8(keyRes.key),
      });
    }
    return call('subscribe', auth, { subscription: sub.toJSON(), label: deviceLabel() });
  }

  async function disable(auth) {
    var reg = await navigator.serviceWorker.getRegistration();
    var sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      var ep = sub.endpoint;
      try { await sub.unsubscribe(); } catch (e) {}
      return call('unsubscribe', auth, { endpoint: ep });
    }
    return { ok: true, devices: 0 };
  }

  async function status(auth) { return call('status', auth); }
  async function test(auth) { return call('test', auth); }

  // Whether *this* phone is one of the ones signed up, as opposed to some
  // other device on the account. "On" needs to mean on, here, now.
  async function thisDeviceOn() {
    if (!supported() || Notification.permission !== 'granted') return false;
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      return !!(reg && await reg.pushManager.getSubscription());
    } catch (e) { return false; }
  }

  /* ── The card both portals drop in ──────────────────────────────── */
  function mount(el, auth) {
    if (!el) return;
    var S = {
      card: 'background:var(--card,#1C1815);border:1px solid var(--border,rgba(182,165,136,0.14));padding:1.1rem 1.15rem;border-radius:10px;',
      h: "font-family:'Josefin Sans',sans-serif;font-size:0.7rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold,#B6A588);margin-bottom:0.5rem;",
      p: "font-family:'Josefin Sans',sans-serif;font-size:0.78rem;color:var(--muted,#8B7355);line-height:1.7;margin-bottom:0.85rem;",
      btn: "background:var(--gold,#B6A588);color:#0B0B0B;border:none;padding:0.65rem 1.1rem;font-size:0.68rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;border-radius:8px;font-family:'Josefin Sans',sans-serif;",
      ghost: "background:transparent;color:var(--gold,#B6A588);border:1px solid var(--border-hi,rgba(182,165,136,0.32));padding:0.65rem 1.1rem;font-size:0.68rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;cursor:pointer;border-radius:8px;font-family:'Josefin Sans',sans-serif;margin-left:0.5rem;",
    };

    async function render(msg) {
      var on = await thisDeviceOn();
      var devices = 0;
      try { devices = (await status(auth)).devices || 0; } catch (e) {}

      var inner = '<div style="' + S.h + '">Phone Notifications</div>';

      if (needsHomeScreen()) {
        inner += '<div style="' + S.p + '">On iPhone these only work once ZOLA is on your Home Screen. ' +
          'Tap the <strong style="color:var(--cream,#F5EEE8)">Share</strong> icon at the bottom of Safari, then ' +
          '<strong style="color:var(--cream,#F5EEE8)">Add to Home Screen</strong>. Open ZOLA from that icon and come back here.</div>';
      } else if (!supported()) {
        inner += '<div style="' + S.p + '">This browser cannot do phone notifications. You will still get every booking by text.</div>';
      } else if (Notification.permission === 'denied') {
        inner += '<div style="' + S.p + '">Notifications are blocked for ZOLA in this browser\'s settings. ' +
          'Allow them there, then come back and turn them on.</div>';
      } else if (on) {
        inner += '<div style="' + S.p + '">On for ' + deviceLabel().toLowerCase() +
          '. New bookings will light up your screen even when the app is closed.' +
          (devices > 1 ? ' (' + devices + ' devices signed up.)' : '') + '</div>' +
          '<button style="' + S.btn + '" data-a="test">Send me a test</button>' +
          '<button style="' + S.ghost + '" data-a="off">Turn off</button>';
      } else {
        inner += '<div style="' + S.p + '">Get new bookings on your lock screen the second they come in — ' +
          'first to confirm takes the appointment.</div>' +
          '<button style="' + S.btn + '" data-a="on">Turn on notifications</button>';
      }

      if (msg) {
        inner += '<div style="font-family:\'Josefin Sans\',sans-serif;font-size:0.76rem;color:var(--cream,#F5EEE8);margin-top:0.8rem;line-height:1.6;">' + msg + '</div>';
      }
      el.innerHTML = '<div style="' + S.card + '">' + inner + '</div>';

      var b;
      if ((b = el.querySelector('[data-a="on"]'))) b.onclick = async function () {
        b.disabled = true; b.textContent = 'Asking…';
        try { await enable(auth); render('Notifications are on for this phone.'); }
        catch (err) {
          render(err.message === 'denied'
            ? 'You tapped Don\'t Allow. Turn notifications back on for ZOLA in your phone settings, then try again.'
            : 'Could not turn them on: ' + err.message);
        }
      };
      if ((b = el.querySelector('[data-a="off"]'))) b.onclick = async function () {
        b.disabled = true;
        try { await disable(auth); } catch (e) {}
        render('Turned off for this phone. You will still get texts.');
      };
      if ((b = el.querySelector('[data-a="test"]'))) b.onclick = async function () {
        b.disabled = true; b.textContent = 'Sending…';
        try {
          var r = await test(auth);
          render(r.sent ? 'Sent — it should appear in a second.' : 'Nothing went out: ' + (r.why || 'no devices signed up'));
        } catch (err) { render('Could not send: ' + err.message); }
      };
    }

    render();
    return render;
  }

  window.ZolaPush = {
    supported: supported, needsHomeScreen: needsHomeScreen, isiOS: isiOS,
    standalone: standalone, thisDeviceOn: thisDeviceOn,
    enable: enable, disable: disable, status: status, test: test, mount: mount,
  };
})();
