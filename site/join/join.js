const id = window.location.hash.slice(1);
if (/^\d{1,19}$/.test(id)) {
  const url = window.location.origin + '/join/#' + id;
  const server = window.location.origin === 'https://bettergit.app' ? '' : " --server '" + window.location.origin + "'";
  document.querySelector('#join-command code').textContent = "bettergit branch join '" + url + "'" + server;
  document.querySelector('#join-command').hidden = false;
  document.querySelector('#join-help').hidden = false;
  document.querySelector('#join-status').hidden = true;
}
