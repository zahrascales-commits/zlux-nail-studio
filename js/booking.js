const API = '';

const state = {
  step: 1,
  service: null,
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
      opt.textContent = `${s.name} — ${fmt.price(s.price_cents)}`;
      sel.appendChild(opt);
    });
  } catch {
    sel.innerHTML = '<option value="">Could not load services</option>';
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
  document.getElementById('sum-service').textContent = state.service ? state.service.name : '—';
  document.getElementById('sum-date').textContent = state.date ? fmt.date(state.date) : '—';
  document.getElementById('sum-time').textContent = state.slot ? fmt.time(state.slot) : '—';
  document.getElementById('sum-price').textContent = state.service ? fmt.price(state.service.price) : '—';
  document.getElementById('sum-duration').textContent = state.service ? `${state.service.duration} min` : '—';
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

  if (!name || !email || !phone) {
    errEl.textContent = 'Please fill in all fields.';
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = 'Please enter a valid email address.';
    return;
  }
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
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        date: state.date,
        time_slot: state.slot,
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Booking failed');
    }
    const data = await res.json();
    showConfirmation(data.confirmation, name);
  } catch (err) {
    errEl.textContent = err.message;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Confirm Booking';
  }
}

function showConfirmation(confirmationId, name) {
  document.getElementById('booking-form-area').style.display = 'none';
  document.getElementById('booking-summary-area').style.display = 'none';
  const box = document.getElementById('confirmation-box');
  box.classList.add('visible');
  document.getElementById('conf-id').textContent = confirmationId;
  document.getElementById('conf-name').textContent = name.split(' ')[0];
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('booking-form-area')) return;

  loadServices();

  // Step 1 — service + date
  const serviceSelect = document.getElementById('service-select');
  const dateInput = document.getElementById('date-input');
  const step1Next = document.getElementById('step1-next');

  // Min date = tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  dateInput.min = tomorrow.toISOString().split('T')[0];

  function checkStep1() {
    step1Next.disabled = !(serviceSelect.value && dateInput.value);
  }

  serviceSelect.addEventListener('change', () => {
    if (!serviceSelect.value) { state.service = null; updateSummary(); checkStep1(); return; }
    const opt = serviceSelect.options[serviceSelect.selectedIndex];
    state.service = { id: +serviceSelect.value, name: opt.dataset.name, price: +opt.dataset.price, duration: +opt.dataset.duration };
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

  // Step 2 — time slot
  document.getElementById('step2-back').addEventListener('click', () => goToStep(1));
  document.getElementById('step2-next').addEventListener('click', () => goToStep(3));

  // Step 3 — details
  document.getElementById('step3-back').addEventListener('click', () => goToStep(2));
  document.getElementById('submit-btn').addEventListener('click', submitBooking);
});
