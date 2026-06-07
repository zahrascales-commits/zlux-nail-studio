const API = '';

const state = {
  step: 1,
  service: null,
  selectedAddons: [],   // array of addon objects
  date: null,
  slot: null,
};

const fmt = {
  price: (cents) => `$${(cents / 100).toFixed(0)}`,
  date: (str) => {
    const [y, m, d] = str.split('-');
    return new Date(+y, +m - 1, +d).toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  },
  time: (str) => {
    const [h, m] = str.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h > 12 ? h - 12 : h || 12}:${m.toString().padStart(2, '0')} ${ampm}`;
  },
};

function calcTotal() {
  if (!state.service) return { total: 0, deposit: 0 };
  const addonSum = state.selectedAddons.reduce((s, a) => s + a.price_cents, 0);
  const total = state.service.price + addonSum;
  const deposit = Math.ceil(total / 2);
  return { total, deposit };
}

async function loadServices() {
  const sel = document.getElementById('service-select');
  try {
    const res = await fetch(`${API}/api/services`);
    const services = await res.json();
    sel.innerHTML = '<option value="">Select a service…</option>';
    services.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.dataset.name = s.name;
      opt.dataset.price = s.price_cents;
      opt.dataset.duration = s.duration_min;
      opt.dataset.startingAt = s.starting_at || '';
      opt.textContent = `${s.name} — ${s.starting_at ? 'from ' : ''}${fmt.price(s.price_cents)}`;
      sel.appendChild(opt);
    });
  } catch {
    sel.innerHTML = '<option value="">Could not load services</option>';
  }
}

async function loadAddons() {
  const list = document.getElementById('addons-list');
  try {
    const res = await fetch(`${API}/api/addons`);
    const addons = await res.json();
    list.innerHTML = '';
    addons.forEach((a) => {
      const label = document.createElement('label');
      label.className = 'addon-label';
      label.innerHTML = `
        <input type="checkbox" class="addon-checkbox" data-id="${a.id}" data-name="${a.name}" data-price="${a.price_cents}" />
        <span class="addon-name">${a.name}</span>
        <span class="addon-price">+${fmt.price(a.price_cents)}</span>
      `;
      list.appendChild(label);
    });

    list.querySelectorAll('.addon-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          state.selectedAddons.push({ id: +cb.dataset.id, name: cb.dataset.name, price_cents: +cb.dataset.price });
        } else {
          state.selectedAddons = state.selectedAddons.filter((a) => a.id !== +cb.dataset.id);
        }
        updateSummary();
      });
    });
  } catch {
    list.innerHTML = '<p class="error-msg">Could not load add-ons.</p>';
  }
}

async function loadSlots() {
  const grid = document.getElementById('slots-grid');
  grid.innerHTML = '<p class="loading-dots">Loading available times…</p>';
  try {
    const res = await fetch(`${API}/api/availability?date=${state.date}&service_id=${state.service.id}`);
    const data = await res.json();
    if (!data.slots.length) {
      grid.innerHTML = '<p class="error-msg">No availability on this date. Please choose another day.</p>';
      return;
    }
    grid.innerHTML = '';
    data.slots.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'slot-btn';
      btn.textContent = fmt.time(s);
      btn.dataset.slot = s;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.slot-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.slot = s;
        updateSummary();
        document.getElementById('step2-next').disabled = false;
      });
      grid.appendChild(btn);
    });
  } catch {
    grid.innerHTML = '<p class="error-msg">Could not load availability. Please try again.</p>';
  }
}

function updateSummary() {
  const { total, deposit } = calcTotal();

  document.getElementById('sum-service').textContent = state.service ? state.service.name : '—';
  document.getElementById('sum-duration').textContent = state.service ? `${state.service.duration} min` : '—';
  document.getElementById('sum-date').textContent = state.date ? fmt.date(state.date) : '—';
  document.getElementById('sum-time').textContent = state.slot ? fmt.time(state.slot) : '—';
  document.getElementById('sum-price').textContent = state.service ? fmt.price(total) : '—';
  document.getElementById('sum-deposit').textContent = state.service ? fmt.price(deposit) : '—';

  // Add-ons row
  const addonsRow = document.getElementById('sum-addons-row');
  const addonsVal = document.getElementById('sum-addons');
  if (state.selectedAddons.length) {
    addonsRow.style.display = 'flex';
    addonsVal.textContent = state.selectedAddons.map((a) => a.name).join(', ');
  } else {
    addonsRow.style.display = 'none';
  }

  // Deposit box in step 3
  const depTotal = document.getElementById('dep-total');
  const depAmount = document.getElementById('dep-amount');
  if (depTotal) depTotal.textContent = state.service ? fmt.price(total) : '—';
  if (depAmount) depAmount.textContent = state.service ? fmt.price(deposit) : '—';
}

function goToStep(n) {
  state.step = n;
  document.querySelectorAll('.booking-step').forEach((el) => el.classList.remove('active'));
  document.getElementById(`step${n}`).classList.add('active');
  document.querySelectorAll('.step-indicator').forEach((el) => {
    const s = +el.dataset.step;
    el.classList.toggle('active', s === n);
    el.classList.toggle('done', s < n);
  });
}

async function submitBooking() {
  const name = document.getElementById('b-name').value.trim();
  const email = document.getElementById('b-email').value.trim();
  const phone = document.getElementById('b-phone').value.trim();
  const errEl = document.getElementById('form-error');

  if (!name || !email || !phone) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Please enter a valid email address.'; return; }
  errEl.textContent = '';

  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Booking…';

  try {
    const res = await fetch(`${API}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: state.service.id,
        addon_ids: state.selectedAddons.map((a) => a.id),
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        date: state.date,
        time_slot: state.slot,
      }),
    });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error || 'Booking failed'); }
    const data = await res.json();
    showConfirmation(data.confirmation, name, data.deposit_cents);
  } catch (err) {
    errEl.textContent = err.message;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm & Pay Deposit';
  }
}

function showConfirmation(confirmationId, name, depositCents) {
  document.getElementById('booking-form-area').style.display = 'none';
  document.getElementById('booking-summary-area').style.display = 'none';
  const box = document.getElementById('confirmation-box');
  box.classList.add('visible');
  document.getElementById('conf-id').textContent = confirmationId;
  document.getElementById('conf-name').textContent = name.split(' ')[0];
  document.getElementById('conf-deposit').textContent = fmt.price(depositCents);
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('booking-form-area')) return;

  loadServices();
  loadAddons();

  const serviceSelect = document.getElementById('service-select');
  const dateInput = document.getElementById('date-input');
  const step1Next = document.getElementById('step1-next');

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  dateInput.min = tomorrow.toISOString().split('T')[0];

  function checkStep1() {
    step1Next.disabled = !(serviceSelect.value && dateInput.value);
  }

  serviceSelect.addEventListener('change', () => {
    const addonsGroup = document.getElementById('addons-group');
    if (!serviceSelect.value) {
      state.service = null;
      addonsGroup.style.display = 'none';
      updateSummary();
      checkStep1();
      return;
    }
    const opt = serviceSelect.options[serviceSelect.selectedIndex];
    state.service = { id: +serviceSelect.value, name: opt.dataset.name, price: +opt.dataset.price, duration: +opt.dataset.duration };
    addonsGroup.style.display = 'block';
    updateSummary();
    checkStep1();
  });

  dateInput.addEventListener('change', () => {
    state.date = dateInput.value;
    state.slot = null;
    updateSummary();
    checkStep1();
  });

  step1Next.addEventListener('click', () => { goToStep(2); loadSlots(); });
  document.getElementById('step2-back').addEventListener('click', () => goToStep(1));
  document.getElementById('step2-next').addEventListener('click', () => { goToStep(3); updateSummary(); });
  document.getElementById('step3-back').addEventListener('click', () => goToStep(2));
  document.getElementById('submit-btn').addEventListener('click', submitBooking);
});
