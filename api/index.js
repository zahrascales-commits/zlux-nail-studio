const express = require('express');
const app = express();

// Stripe webhook needs raw body BEFORE global JSON parsing
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), require('./_stripe-webhook'));

// JSON body parsing for all other routes
app.use(express.json());

// Original site API routes
app.all('/api/services',         require('./_services'));
app.all('/api/availability',     require('./_availability'));
app.all('/api/bookings',         require('./_bookings'));
app.all('/api/addons',           require('./_addons'));

// Member routes
app.all('/api/member-signup',    require('./_member-signup'));
app.all('/api/member-login',     require('./_member-login'));
app.all('/api/member-profile',   require('./_member-profile'));
app.all('/api/booking-windows',  require('./_booking-windows'));
app.all('/api/qr-generate',      require('./_qr-generate'));
app.all('/api/qr-verify',        require('./_qr-verify'));
app.all('/api/referral',         require('./_referral'));

// Staff routes
app.all('/api/staff-auth',       require('./_staff-auth'));
app.all('/api/staff-data',       require('./_staff-data'));

// Admin routes
app.all('/api/admin-auth',       require('./_admin-auth'));
app.all('/api/admin-members',    require('./_admin-members'));
app.all('/api/admin-revenue',    require('./_admin-revenue'));
app.all('/api/admin-messaging',  require('./_admin-messaging'));
app.all('/api/admin-inventory',  require('./_admin-inventory'));
app.all('/api/admin-schedule',   require('./_admin-schedule'));
app.all('/api/waitlist',         require('./_waitlist'));
app.all('/api/no-show',          require('./_no-show'));

// CEO dashboard routes
app.all('/api/ceo-data',         require('./_ceo-data'));
app.all('/api/calendar-blocks',  require('./_calendar-blocks'));

// Worker portal routes (legacy — kept for backwards compatibility)
app.all('/api/worker',           require('./_worker'));

// Team Member system (owner manager + team portal + client chat) — Turso-backed
app.all('/api/manager',          require('./_manager'));
app.all('/api/team',             require('./_team'));

// AI (Ask Zola chat + owner reply drafts), inquiries inbox, editable site settings
app.all('/api/chat',             require('./_ai'));
app.all('/api/ai',               require('./_ai'));
app.all('/api/inquiries',        require('./_inquiries'));
app.all('/api/site-settings',    require('./_site-settings'));
app.all('/api/clients',          require('./_clients'));
app.all('/api/notifications',    require('./_notifications'));
app.all('/api/pay',              require('./_pay'));
app.all('/api/account',          require('./_account'));
app.all('/api/photos',           require('./_photos'));

// Reminders (24h + 2h before appointment — call daily via cron)
app.all('/api/reminders',        require('./_reminders'));

module.exports = app;
