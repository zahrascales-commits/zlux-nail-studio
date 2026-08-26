// The client profile sheet, shared by Studio Manager and the Team Portal.
//
// Anywhere a client's name appears, tapping it opens this: who they are, how
// to reach them, every visit they have ever had, what they paid, and the
// notes the team has written about them. One component so the two screens
// cannot show the same person differently.
//
// Zahra can edit; artists can only add notes. That split is enforced on the
// server too — this just stops the page offering something it would refuse.
(function () {
  var CSS = [
    '.cp-veil{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.62);backdrop-filter:blur(3px);',
    '  display:none;align-items:flex-end;justify-content:center}',
    '.cp-veil.open{display:flex}',
    '@media(min-width:700px){.cp-veil{align-items:center}}',
    '.cp-box{background:#141210;border:1px solid rgba(182,165,136,0.34);width:100%;max-width:560px;max-height:88vh;',
    '  overflow:auto;color:#F5EEE8;font-family:"Josefin Sans",sans-serif;border-radius:14px 14px 0 0}',
    '@media(min-width:700px){.cp-box{border-radius:14px}}',
    '.cp-head{position:sticky;top:0;background:#141210;border-bottom:1px solid rgba(182,165,136,0.2);',
    '  padding:1.1rem 1.2rem;display:flex;gap:0.8rem;align-items:flex-start;z-index:2}',
    '.cp-av{width:46px;height:46px;border-radius:50%;background:linear-gradient(140deg,#C9B896,#8C7A5E);flex-shrink:0;',
    '  display:flex;align-items:center;justify-content:center;font-family:"Cinzel",serif;font-size:1.2rem;color:#1A140C}',
    '.cp-name{font-family:"Cinzel",serif;font-size:1.25rem;color:#F5EEE8;line-height:1.2}',
    '.cp-sub{font-size:0.76rem;color:#8C7A5E;margin-top:0.2rem;line-height:1.6}',
    '.cp-x{margin-left:auto;background:none;border:none;color:#8C7A5E;font-size:1.5rem;cursor:pointer;line-height:1;padding:0 0.2rem}',
    '.cp-body{padding:1.1rem 1.2rem 1.5rem}',
    '.cp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:0.55rem;margin-bottom:1.1rem}',
    '.cp-stat{background:rgba(255,255,255,0.04);border:1px solid rgba(182,165,136,0.2);padding:0.65rem 0.5rem;',
    '  text-align:center;border-radius:8px}',
    '.cp-n{font-family:"Cinzel",serif;font-size:1.3rem;color:#DDD0B8;line-height:1}',
    '.cp-l{font-size:0.56rem;letter-spacing:0.12em;text-transform:uppercase;color:#8C7A5E;margin-top:0.3rem}',
    '.cp-h{font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;color:#B6A588;margin:1.2rem 0 0.6rem}',
    '.cp-row{display:flex;gap:0.7rem;align-items:flex-start;border-top:1px solid rgba(182,165,136,0.14);padding:0.6rem 0}',
    '.cp-when{min-width:104px;font-size:0.78rem;color:#DDD0B8}',
    '.cp-when i{display:block;font-style:normal;font-size:0.68rem;color:#8C7A5E}',
    '.cp-what{flex:1;min-width:0;font-size:0.84rem;color:#F5EEE8}',
    '.cp-what i{display:block;font-style:normal;font-size:0.72rem;color:#8C7A5E;margin-top:0.1rem}',
    '.cp-amt{text-align:right;font-size:0.82rem;color:#DDD0B8;min-width:74px}',
    '.cp-amt i{display:block;font-style:normal;font-size:0.62rem;color:#7ec98a}',
    '.cp-amt.unpaid i{color:#d68a8a}',
    '.cp-note{background:rgba(255,255,255,0.04);border:1px solid rgba(182,165,136,0.18);border-radius:8px;',
    '  padding:0.7rem 0.8rem;margin-bottom:0.5rem}',
    '.cp-note.pin{border-color:#B6A588;background:rgba(182,165,136,0.12)}',
    '.cp-note p{font-size:0.85rem;line-height:1.65;color:#F5EEE8;margin:0 0 0.35rem}',
    '.cp-note span{font-size:0.66rem;color:#8C7A5E}',
    '.cp-add{width:100%;background:#0B0B0B;border:1px solid rgba(182,165,136,0.28);color:#F5EEE8;',
    '  padding:0.7rem 0.8rem;font-family:inherit;font-size:0.86rem;border-radius:8px;resize:vertical;outline:none}',
    '.cp-btn{background:#B6A588;color:#0B0B0B;border:none;padding:0.6rem 1.1rem;border-radius:7px;cursor:pointer;',
    '  font-family:inherit;font-size:0.66rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-top:0.6rem}',
    '.cp-ghost{background:none;color:#B6A588;border:1px solid rgba(182,165,136,0.3);margin-left:0.4rem}',
    '.cp-empty{font-size:0.82rem;color:#8C7A5E;padding:0.6rem 0}',
    '.cp-tag{display:inline-block;font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;',
    '  border:1px solid #B6A588;color:#DDD0B8;padding:0.2rem 0.5rem;border-radius:100px;margin-top:0.35rem}',
    // An allergy is not a note. It sits above everything else on this sheet,
    // in red, because the cost of missing it is somebody's skin.
    '.cp-alert{background:rgba(200,80,80,0.14);border:1px solid rgba(220,110,110,0.55);border-radius:9px;',
    '  padding:0.85rem 0.95rem;margin-bottom:0.9rem}',
    '.cp-alert b{display:block;font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;',
    '  color:#ffb3b3;margin-bottom:0.35rem}',
    '.cp-alert p{font-size:0.88rem;line-height:1.6;color:#ffd9d9;margin:0}',
    '.cp-pref{display:flex;gap:0.7rem;padding:0.5rem 0;border-top:1px solid rgba(182,165,136,0.14);font-size:0.84rem}',
    '.cp-pref .k{min-width:112px;color:#8C7A5E;flex-shrink:0}',
    '.cp-pref .v{flex:1;color:#F5EEE8;min-width:0}',
    '.cp-chip{display:inline-block;font-size:0.7rem;border:1px solid rgba(182,165,136,0.35);border-radius:100px;',
    '  padding:0.22rem 0.6rem;margin:0.2rem 0.25rem 0 0;color:#DDD0B8}',
    '.cp-chip.hi{border-color:#d66;color:#ffb3b3}',
    '.cp-score{display:flex;align-items:center;gap:0.7rem;margin-bottom:0.7rem}',
    '.cp-score b{font-family:"Cinzel",serif;font-size:1.9rem;color:#DDD0B8;line-height:1}',
    '.cp-score span{font-size:0.78rem;color:#8C7A5E;line-height:1.5}',
  ].join('\n');

  var mounted = false, auth = {}, current = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(c) { return c == null ? '—' : '$' + (Number(c) / 100).toFixed(2); }
  function niceDate(ds) {
    if (!ds) return '—';
    var d = new Date(String(ds).slice(0, 10) + 'T12:00:00');
    return isNaN(d) ? String(ds) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function time12(t) {
    if (!t) return '';
    var p = String(t).split(':'), h = Number(p[0]);
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    return h + ':' + (p[1] || '00') + ' ' + ap;
  }

  function mount() {
    if (mounted) return;
    var st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    var v = document.createElement('div');
    v.className = 'cp-veil';
    v.id = 'cp-veil';
    v.innerHTML = '<div class="cp-box" id="cp-box"></div>';
    v.addEventListener('click', function (e) { if (e.target === v) close(); });
    document.body.appendChild(v);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && v.classList.contains('open')) close();
    });
    mounted = true;
  }

  function close() {
    var v = document.getElementById('cp-veil');
    if (v) v.classList.remove('open');
    document.body.style.overflow = '';
  }

  function headers() {
    var h = { 'Content-Type': 'application/json' };
    if (auth.pass) h['X-CEO-Password'] = auth.pass;
    if (auth.member_id) { h['X-Team-Id'] = String(auth.member_id); h['X-Team-Pin'] = auth.pin; }
    return h;
  }

  // `who` is whatever the calling screen knows: {id} or {name, email, phone}.
  async function open(who) {
    mount();
    current = who || {};
    var box = document.getElementById('cp-box');
    document.getElementById('cp-veil').classList.add('open');
    document.body.style.overflow = 'hidden';
    box.innerHTML = '<div class="cp-body"><div class="cp-empty">Loading…</div></div>';

    var qs = Object.keys(current)
      .filter(function (k) { return current[k]; })
      .map(function (k) { return k + '=' + encodeURIComponent(current[k]); }).join('&');

    var d;
    try {
      var r = await fetch('/api/clients?action=profile&' + qs, { headers: headers() });
      d = await r.json();
      if (d.error) throw new Error(d.error);
    } catch (err) {
      box.innerHTML = '<div class="cp-body"><div class="cp-empty">Could not open this profile: '
        + esc(err.message) + '</div></div>';
      return;
    }
    render(d);
  }

  function render(d) {
    var c = d.client || {}, t = d.totals || {}, m = d.membership;
    var box = document.getElementById('cp-box');
    var initial = (String(c.name || '?').trim().charAt(0) || '?').toUpperCase();

    var contact = [c.phone, c.email].filter(Boolean).join(' · ');
    var head =
      '<div class="cp-head">'
      + '<div class="cp-av">' + esc(initial) + '</div>'
      + '<div style="flex:1;min-width:0">'
        + '<div class="cp-name">' + esc(c.name || 'Unnamed client') + '</div>'
        + '<div class="cp-sub">' + (contact ? esc(contact) : 'No contact details on file') + '</div>'
        + (m ? '<span class="cp-tag">' + esc(String(m.tier).replace('_', ' ')) + '</span>' : '')
        + (m && m.age ? '<span class="cp-tag">' + m.age + ' years old</span>' : '')
        + (c.unfiled ? '<span class="cp-tag">Not yet filed</span>' : '')
      + '</div>'
      + '<button class="cp-x" onclick="ZolaClient.close()">&times;</button>'
      + '</div>';

    var stats =
      '<div class="cp-stats">'
      + stat(t.visits || 0, (t.visits === 1 ? 'visit' : 'visits'))
      + stat(money(t.spent_cents || 0), 'spent')
      + (t.cancelled ? stat(t.cancelled, 'cancelled') : '')
      + (t.first_visit ? stat(niceDate(t.first_visit), 'first came') : '')
      + '</div>';

    var likes = [
      c.likes ? '<div class="cp-note"><p><strong>Likes:</strong> ' + esc(c.likes) + '</p></div>' : '',
      c.dislikes ? '<div class="cp-note"><p><strong>Avoid:</strong> ' + esc(c.dislikes) + '</p></div>' : '',
      c.notes ? '<div class="cp-note"><p>' + esc(c.notes) + '</p></div>' : '',
    ].join('');

    // ── what they told us about their own nails ──
    var n = d.nails, intake = d.intake;

    // Anything that could hurt somebody goes to the very top of the sheet,
    // before the visit count, before the notes. Buried safety information is
    // the same as none.
    var alerts = '';
    if (n && n.allergy) {
      alerts += '<div class="cp-alert"><b>&#9888; Allergy / sensitivity</b><p>' + esc(n.allergy) + '</p></div>';
    }
    if (n && (n.flagged || []).some(function (f) { return f.severity >= 3; })) {
      alerts += '<div class="cp-alert"><b>&#9888; Handle with care</b><p>'
        + n.flagged.filter(function (f) { return f.severity >= 3; })
            .map(function (f) { return esc(f.label); }).join(' &middot; ')
        + '</p></div>';
    }

    var pref = function (k, v) {
      return v ? '<div class="cp-pref"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>' : '';
    };

    var nailHtml = '';
    if (n) {
      nailHtml += '<div class="cp-score"><b>' + (n.score || '&mdash;') + '</b>'
        + '<span>' + esc(n.band || '') + (n.goal ? '<br>Working towards: ' + esc(n.goal) : '') + '</span></div>';
      if ((n.flagged || []).length) {
        nailHtml += '<div class="cp-pref"><div class="k">Nail issues</div><div class="v">'
          + n.flagged.map(function (f) {
              return '<span class="cp-chip' + (f.severity >= 2 ? ' hi' : '') + '">' + esc(f.label)
                + ' &middot; ' + (['', 'a little', 'quite a bit', 'a lot'][f.severity] || '') + '</span>';
            }).join('')
          + '</div></div>';
      }
      nailHtml += pref('Shape they like', n.shape)
        + pref('Length they like', n.length)
        + pref('Hands at work', n.job)
        + pref('Never again', n.dislikes)
        + pref('What they want', n.wants);
    }
    if (intake && intake.answers) {
      Object.keys(intake.answers).forEach(function (k) {
        var v = intake.answers[k];
        if (v && typeof v === 'string') nailHtml += pref(k.replace(/_/g, ' '), v);
      });
      if (intake.note) nailHtml += pref('Their note', intake.note);
    }

    var notes = (d.notes || []).map(function (n) {
      return '<div class="cp-note' + (Number(n.pinned) ? ' pin' : '') + '">'
        + '<p>' + esc(n.note) + '</p>'
        + '<span>' + esc(n.author || 'someone') + ' · ' + niceDate(new Date(Number(n.ts)).toISOString())
        + (Number(n.pinned) ? ' · pinned' : '') + '</span>'
        + (d.can_edit
            ? '<button class="cp-btn cp-ghost" style="margin-top:0.45rem;padding:0.35rem 0.7rem"'
              + ' onclick="ZolaClient.pin(' + n.id + ',' + (Number(n.pinned) ? 0 : 1) + ')">'
              + (Number(n.pinned) ? 'Unpin' : 'Pin to top') + '</button>'
            : '')
        + '</div>';
    }).join('') || '<div class="cp-empty">No notes yet.</div>';

    var visits = (d.visits || []).map(function (v) {
      var off = String(v.status || '').toLowerCase() === 'cancelled';
      return '<div class="cp-row"' + (off ? ' style="opacity:0.5"' : '') + '>'
        + '<div class="cp-when">' + niceDate(v.date) + '<i>' + esc(time12(v.time)) + '</i></div>'
        + '<div class="cp-what">' + esc(v.service || 'Appointment')
          + (off ? ' · cancelled' : '')
          + '<i>' + (v.provider ? 'with ' + esc(v.provider) : 'no artist recorded')
          + (v.addons && v.addons.length ? ' · +' + esc(v.addons.join(', ')) : '') + '</i></div>'
        + '<div class="cp-amt' + (v.deposit_paid ? '' : ' unpaid') + '">' + money(v.total_cents)
          + '<i>' + (v.deposit_paid ? 'deposit paid' : 'no deposit') + '</i></div>'
        + '</div>';
    }).join('') || '<div class="cp-empty">No visits on record yet.</div>';

    box.innerHTML = head + '<div class="cp-body">'
      + alerts
      + stats
      + (nailHtml ? '<div class="cp-h">Their nails, in their words</div>' + nailHtml : '')
      + (likes ? '<div class="cp-h">What we know</div>' + likes : '')
      + '<div class="cp-h">Notes from the team</div>'
      + notes
      + '<textarea class="cp-add" id="cp-new" rows="2" placeholder="Add a note — it shows up wherever this client appears"></textarea>'
      + '<button class="cp-btn" onclick="ZolaClient.addNote(this)">Add note</button>'
      + '<div class="cp-h">Every visit</div>'
      + visits
      + '</div>';
  }

  function stat(n, label) {
    return '<div class="cp-stat"><div class="cp-n">' + n + '</div><div class="cp-l">' + label + '</div></div>';
  }

  async function addNote(btn) {
    var el = document.getElementById('cp-new');
    var text = el && el.value.trim();
    if (!text) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      var body = Object.assign({ action: 'note', note: text }, current, auth);
      var r = await fetch('/api/clients?action=note', {
        method: 'POST', headers: headers(), body: JSON.stringify(body),
      });
      var d = await r.json();
      if (d.error) throw new Error(d.error);
      open(current);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Add note'; }
      alert(err.message || 'Could not save that note.');
    }
  }

  async function pin(id, on) {
    try {
      await fetch('/api/clients?action=pin_note', {
        method: 'PUT', headers: headers(), body: JSON.stringify({ action: 'pin_note', id: id, pinned: on }),
      });
      open(current);
    } catch (_) {}
  }

  window.ZolaClient = {
    // auth: {pass} for Zahra, {member_id, pin} for an artist
    init: function (a) { auth = a || {}; mount(); },
    open: open, close: close, addNote: addNote, pin: pin,
  };
})();
