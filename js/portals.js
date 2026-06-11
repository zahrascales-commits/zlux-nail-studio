// Portal auth guard — call on protected pages
function requireRole(role) {
  const current = sessionStorage.getItem('zlux_role');
  if (!current) { window.location.href = '/client-portal.html'; return false; }
  if (role && current !== role) {
    if (current === 'ADMIN') window.location.href = '/dashboard.html';
    else if (current === 'WORKER') window.location.href = '/team.html';
    else window.location.href = '/client-portal.html';
    return false;
  }
  return true;
}
