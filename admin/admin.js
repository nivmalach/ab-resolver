// Admin Dashboard JavaScript
let experiments = [];
let teamMembers = [];
let allowedOrigins = [];
let currentAdmin = null;
const accessRoles = ['viewer', 'manager', 'owner'];

function canManageExperiments() {
  return currentAdmin && ['owner', 'manager'].includes(currentAdmin.role);
}

function canManageTeam() {
  return currentAdmin && currentAdmin.role === 'owner';
}

// Generate random ID
function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id;
  do {
    id = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (experiments.some(e => e.id === id));
  return id;
}

// Toast notifications
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.className = 'toast', 3000);
}

// Format date
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  // Format to YYYY-MM-DD HH:mm:ss UTC
  return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

// Initialize datetime inputs with current UTC time on focus
function initDateTimeInput(input) {
  input.addEventListener('focus', function() {
    if (this.value) return;  // Don't override if already has value
    const now = new Date();
    // Round to nearest minute
    now.setSeconds(0);
    now.setMilliseconds(0);
    this.value = now.toISOString().slice(0, 16);
  });
}

// Format date for input - convert from UTC to local time for input display
function formatDateInput(dateStr) {
  if (!dateStr) return '';  // Return empty for no date
  const d = new Date(dateStr);
  // Convert UTC to local time for input
  const local = new Date(d.getTime() - (d.getTimezoneOffset() * 60000));
  return local.toISOString().slice(0, 16);  // Format for datetime-local input
}

// Format percentage
function formatPercent(num) {
  return (num * 100).toFixed(0) + '%';
}

function appendText(parent, tag, text, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function createIcon(name) {
  const icon = document.createElement('span');
  icon.className = 'material-icons';
  icon.textContent = name;
  return icon;
}

function createButton(iconName, title, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = title;
  button.appendChild(createIcon(iconName));
  button.addEventListener('click', onClick);
  return button;
}

async function getErrorMessage(response, fallback) {
  const payload = await response.json().catch(() => null);
  if (payload && payload.detail) return payload.detail;
  if (payload && payload.error) return payload.error;
  return fallback;
}

async function fetchCurrentAdmin() {
  try {
    const res = await fetch('/admin/me');
    if (!res.ok) throw new Error('Failed to load current admin');
    currentAdmin = await res.json();
    document.getElementById('new-exp').hidden = !canManageExperiments();
  } catch {
    currentAdmin = null;
    document.getElementById('new-exp').hidden = true;
  }
}

// Force variant
async function forceVariant(expId, variant) {
  const exp = experiments.find(e => e.id === expId);
  if (!exp) return;
  
  const url = variant === 'A' ? exp.baseline_url : exp.test_url;
  const urlObj = new URL(url);
  urlObj.searchParams.set('__exp', `force${variant}`);
  window.open(urlObj.toString(), '_blank');
}

// Render experiments table
function renderTable(exps = experiments) {
  const container = document.getElementById('experimentsTable');
  const canWrite = canManageExperiments();
  
  if (exps.length === 0) {
    container.innerHTML = '<div class="empty-state">No experiments found</div>';
    return;
  }
  
  // Restore table if showing empty state
  if (!container.querySelector('table')) {
    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Status</th>
            <th>URLs</th>
            <th>Split</th>
            <th>Dates</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="expTableBody"></tbody>
      </table>
    `;
  }

  const tbody = document.getElementById('expTableBody');
  tbody.textContent = '';
  
  exps.forEach(exp => {
    const tr = document.createElement('tr');

    const metaTd = document.createElement('td');
    const idEl = appendText(metaTd, 'div', exp.id);
    idEl.style.fontWeight = '500';
    const createdEl = appendText(metaTd, 'small', `Created ${formatDate(exp.created_at)}`);
    createdEl.style.color = 'var(--gray-500)';
    tr.appendChild(metaTd);

    appendText(tr, 'td', exp.name);

    const statusTd = document.createElement('td');
    const status = document.createElement('span');
    status.className = `status ${exp.status}`;
    const statusIcon = createIcon(exp.status === 'running' ? 'play_arrow' : exp.status === 'stopped' ? 'stop' : 'pause');
    statusIcon.style.fontSize = '1rem';
    status.appendChild(statusIcon);
    status.appendChild(document.createTextNode(` ${exp.status}`));
    statusTd.appendChild(status);
    tr.appendChild(statusTd);

    const urlsTd = document.createElement('td');
    const urlActions = document.createElement('div');
    urlActions.style.display = 'flex';
    urlActions.style.flexDirection = 'column';
    urlActions.style.gap = '0.5rem';
    [['A', 'radio_button_unchecked', 'Baseline'], ['B', 'change_history', 'Test']].forEach(([variant, iconName, label]) => {
      const link = document.createElement('a');
      link.href = '#';
      link.style.display = 'flex';
      link.style.alignItems = 'center';
      link.style.gap = '0.25rem';
      link.style.color = 'var(--gray-700)';
      link.style.textDecoration = 'none';
      const icon = createIcon(iconName);
      icon.style.fontSize = '1rem';
      link.appendChild(icon);
      link.appendChild(document.createTextNode(label));
      link.addEventListener('click', (event) => {
        event.preventDefault();
        forceVariant(exp.id, variant);
      });
      urlActions.appendChild(link);
    });
    urlsTd.appendChild(urlActions);
    tr.appendChild(urlsTd);

    const splitTd = document.createElement('td');
    const splitWrap = document.createElement('div');
    splitWrap.style.display = 'flex';
    splitWrap.style.alignItems = 'center';
    splitWrap.style.gap = '0.5rem';
    const track = document.createElement('div');
    track.style.flex = '1';
    track.style.height = '4px';
    track.style.background = 'var(--gray-200)';
    track.style.borderRadius = '2px';
    const fill = document.createElement('div');
    fill.style.width = formatPercent(exp.allocation_b);
    fill.style.height = '100%';
    fill.style.background = 'var(--primary)';
    fill.style.borderRadius = '2px';
    track.appendChild(fill);
    splitWrap.appendChild(track);
    const splitLabel = appendText(splitWrap, 'span', formatPercent(exp.allocation_b));
    splitLabel.style.color = 'var(--gray-600)';
    splitLabel.style.fontSize = '0.875rem';
    splitTd.appendChild(splitWrap);
    tr.appendChild(splitTd);

    const datesTd = document.createElement('td');
    const datesWrap = document.createElement('div');
    datesWrap.style.display = 'flex';
    datesWrap.style.flexDirection = 'column';
    datesWrap.style.gap = '0.25rem';
    [['Start:', exp.start_at], ['End:', exp.stop_at]].forEach(([label, value]) => {
      const row = document.createElement('div');
      const small = appendText(row, 'small', label);
      small.style.color = 'var(--gray-500)';
      row.appendChild(document.createTextNode(` ${formatDate(value)}`));
      datesWrap.appendChild(row);
    });
    datesTd.appendChild(datesWrap);
    tr.appendChild(datesTd);

    const actionsTd = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'button-group';
    actions.style.display = 'flex';
    actions.style.gap = '0.5rem';
    if (canWrite) {
      if (exp.status !== 'running') {
        actions.appendChild(createButton('play_arrow', 'Start', 'button primary', () => updateStatus(exp.id, 'running')));
      }
      if (exp.status === 'running') {
        actions.appendChild(createButton('stop', 'Stop', 'button danger', () => updateStatus(exp.id, 'stopped')));
      }
      const editButton = createButton('edit', 'Edit', 'button', () => editExp(exp.id));
      editButton.style.background = 'var(--gray-700)';
      editButton.style.color = 'white';
      actions.appendChild(editButton);
      actions.appendChild(createButton('delete', 'Delete', 'button danger', () => deleteExp(exp.id)));
    } else {
      appendText(actions, 'span', 'View only');
    }
    actionsTd.appendChild(actions);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });
}

// Fetch and render experiments
async function fetchExperiments() {
  try {
    const res = await fetch('/experiments');
    if (!res.ok) throw new Error('Failed to load experiments');
    experiments = await res.json();
    if (!Array.isArray(experiments)) throw new Error('Invalid experiments response');
    renderTable();
  } catch (err) {
    showToast('Failed to load experiments', 'error');
  }
}

function renderTeamMembers() {
  const section = document.getElementById('team-members');
  if (!canManageTeam()) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const tbody = document.getElementById('teamMembersBody');
  tbody.textContent = '';

  if (teamMembers.length === 0) {
    const tr = document.createElement('tr');
    const td = appendText(tr, 'td', 'No team members found');
    td.colSpan = 4;
    td.className = 'empty-row';
    tbody.appendChild(tr);
    return;
  }

  teamMembers.forEach(user => {
    const tr = document.createElement('tr');
    appendText(tr, 'td', user.email);

    const roleTd = document.createElement('td');
    const roleSelect = document.createElement('select');
    roleSelect.value = user.role;
    accessRoles.forEach(role => {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = role;
      roleSelect.appendChild(option);
    });
    roleSelect.addEventListener('change', () => updateTeamMember(user.email, { role: roleSelect.value }));
    roleTd.appendChild(roleSelect);
    tr.appendChild(roleTd);

    const statusTd = document.createElement('td');
    const status = document.createElement('span');
    status.className = `status ${user.active ? 'running' : 'stopped'}`;
    status.textContent = user.active ? 'active' : 'inactive';
    statusTd.appendChild(status);
    tr.appendChild(statusTd);

    const actionsTd = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'button-group';
    actions.style.display = 'flex';
    actions.style.gap = '0.5rem';
    const isSelf = currentAdmin && currentAdmin.email === user.email;
    const toggleButton = createButton(
      user.active ? 'person_off' : 'person_check',
      user.active ? 'Deactivate' : 'Activate',
      user.active ? 'button danger' : 'button primary',
      () => updateTeamMember(user.email, { active: !user.active })
    );
    toggleButton.disabled = isSelf;
    actions.appendChild(toggleButton);

    const deleteButton = createButton('delete', 'Delete', 'button danger', () => deleteTeamMember(user.email));
    deleteButton.disabled = isSelf;
    actions.appendChild(deleteButton);
    actionsTd.appendChild(actions);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });
}

function renderAllowedOrigins() {
  const section = document.getElementById('allowed-origins');
  if (!canManageTeam()) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const tbody = document.getElementById('allowedOriginsBody');
  tbody.textContent = '';

  if (allowedOrigins.length === 0) {
    const tr = document.createElement('tr');
    const td = appendText(tr, 'td', 'No allowed origins found');
    td.colSpan = 3;
    td.className = 'empty-row';
    tbody.appendChild(tr);
    return;
  }

  allowedOrigins.forEach(originConfig => {
    const tr = document.createElement('tr');
    appendText(tr, 'td', originConfig.origin);

    const statusTd = document.createElement('td');
    const status = document.createElement('span');
    status.className = `status ${originConfig.active ? 'running' : 'stopped'}`;
    status.textContent = originConfig.active ? 'active' : 'inactive';
    statusTd.appendChild(status);
    tr.appendChild(statusTd);

    const actionsTd = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'button-group';
    actions.style.display = 'flex';
    actions.style.gap = '0.5rem';

    actions.appendChild(createButton(
      originConfig.active ? 'link_off' : 'add_link',
      originConfig.active ? 'Deactivate' : 'Activate',
      originConfig.active ? 'button danger' : 'button primary',
      () => updateAllowedOrigin(originConfig.origin, { active: !originConfig.active })
    ));
    actions.appendChild(createButton('delete', 'Delete', 'button danger', () => deleteAllowedOrigin(originConfig.origin)));
    actionsTd.appendChild(actions);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });
}

async function fetchAllowedOrigins() {
  if (!canManageTeam()) {
    allowedOrigins = [];
    renderAllowedOrigins();
    return;
  }

  try {
    const res = await fetch('/admin/allowed-origins');
    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to load allowed origins'));
    allowedOrigins = await res.json();
    if (!Array.isArray(allowedOrigins)) throw new Error('Invalid allowed origins response');
    renderAllowedOrigins();
  } catch {
    showToast('Failed to load allowed origins', 'error');
  }
}

async function updateAllowedOrigin(origin, updates) {
  try {
    const res = await fetch('/admin/allowed-origins', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, ...updates })
    });
    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to update allowed origin'));
    await fetchAllowedOrigins();
    showToast('Allowed origin updated');
  } catch (err) {
    showToast(err.message || 'Failed to update allowed origin', 'error');
    await fetchAllowedOrigins();
  }
}

async function deleteAllowedOrigin(origin) {
  if (!confirm(`Delete allowed origin ${origin}?`)) return;

  try {
    const query = new URLSearchParams({ origin });
    const res = await fetch(`/admin/allowed-origins?${query.toString()}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to delete allowed origin'));
    await fetchAllowedOrigins();
    showToast('Allowed origin deleted');
  } catch (err) {
    showToast(err.message || 'Failed to delete allowed origin', 'error');
  }
}

async function fetchTeamMembers() {
  if (!canManageTeam()) {
    teamMembers = [];
    renderTeamMembers();
    return;
  }

  try {
    const res = await fetch('/admin/team-members');
    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to load team members'));
    teamMembers = await res.json();
    if (!Array.isArray(teamMembers)) throw new Error('Invalid team members response');
    renderTeamMembers();
  } catch {
    showToast('Failed to load team members', 'error');
  }
}

async function updateTeamMember(email, updates) {
  try {
    const res = await fetch(`/admin/team-members/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to update team member'));
    await fetchTeamMembers();
    showToast('Team member updated');
  } catch (err) {
    showToast(err.message || 'Failed to update team member', 'error');
    await fetchTeamMembers();
  }
}

async function deleteTeamMember(email) {
  if (!confirm(`Delete team member ${email}?`)) return;

  try {
    const res = await fetch(`/admin/team-members/${encodeURIComponent(email)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to delete team member'));
    await fetchTeamMembers();
    showToast('Team member deleted');
  } catch (err) {
    showToast(err.message || 'Failed to delete team member', 'error');
  }
}

// Update experiment status
async function updateStatus(id, status) {
  try {
    const res = await fetch(`/experiments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Failed to update status');
    await fetchExperiments();
    showToast(`Experiment ${status}`);
  } catch (err) {
    showToast('Failed to update experiment', 'error');
  }
}

// Delete experiment
async function deleteExp(id) {
  if (!confirm('Are you sure you want to delete this experiment? This action cannot be undone.')) return;
  
  try {
    const res = await fetch(`/experiments/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete');
    await fetchExperiments();
    showToast('Experiment deleted');
  } catch (err) {
    showToast('Failed to delete experiment', 'error');
  }
}

// Handle form submission
document.getElementById('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!canManageExperiments()) {
    showToast('This role can view experiments but cannot change them', 'error');
    return;
  }
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  
  // Add generated ID
  data.id = generateId();
  
  // Format data
  data.allocation_b = parseFloat(data.allocation_b);
  
  try {
    const res = await fetch('/experiments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (!res.ok) throw new Error('Failed to create experiment');
    
    form.reset();
    await fetchExperiments();
    showToast('Experiment created successfully');
  } catch (err) {
    showToast('Failed to create experiment', 'error');
  }
});

document.getElementById('teamMemberForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!canManageTeam()) {
    showToast('Only owners can manage team members', 'error');
    return;
  }
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));

  try {
    const res = await fetch('/admin/team-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to add team member'));

    form.reset();
    await fetchTeamMembers();
    showToast('Team member added');
  } catch (err) {
    showToast(err.message || 'Failed to add team member', 'error');
  }
});

document.getElementById('allowedOriginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!canManageTeam()) {
    showToast('Only owners can manage allowed origins', 'error');
    return;
  }
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));

  try {
    const res = await fetch('/admin/allowed-origins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) throw new Error(await getErrorMessage(res, 'Failed to add allowed origin'));

    form.reset();
    await fetchAllowedOrigins();
    showToast('Allowed origin added');
  } catch (err) {
    showToast(err.message || 'Failed to add allowed origin', 'error');
  }
});

// Edit experiment
function editExp(id) {
  const exp = experiments.find(e => e.id === id);
  if (!exp) return;

  const form = document.getElementById('editForm');
  const modal = document.getElementById('editModal');
  const splitInput = document.getElementById('edit-split');
  const splitOutput = splitInput.nextElementSibling;

  // Fill form
  form.elements.id.value = exp.id;
  form.elements.name.value = exp.name;
  form.elements.baseline_url.value = exp.baseline_url;
  form.elements.test_url.value = exp.test_url;
  form.elements.allocation_b.value = exp.allocation_b;
  form.elements.status.value = exp.status;
  
  // Set dates if they exist
  form.elements.start_at.value = formatDateInput(exp.start_at);
  form.elements.stop_at.value = formatDateInput(exp.stop_at);
  
  // Update split display
  splitOutput.value = formatPercent(exp.allocation_b);
  
  // Show modal
  modal.className = 'modal show';
}

// Close edit modal
function closeEditModal() {
  document.getElementById('editModal').className = 'modal';
}

// Handle edit form submission
document.getElementById('editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  const id = data.id;
  delete data.id;
  
  // Format data
  data.allocation_b = parseFloat(data.allocation_b);
  if (!data.start_at) data.start_at = null;
  if (!data.stop_at) data.stop_at = null;
  
  try {
    const res = await fetch(`/experiments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    
    if (!res.ok) throw new Error('Failed to update experiment');
    
    closeEditModal();
    await fetchExperiments();
    showToast('Experiment updated successfully');
  } catch (err) {
    showToast('Failed to update experiment', 'error');
  }
});

// Handle split ratio inputs
const splitInput = document.getElementById('exp-split');
const splitOutput = splitInput.nextElementSibling;
splitInput.addEventListener('input', () => {
  splitOutput.value = formatPercent(splitInput.value);
});

const editSplitInput = document.getElementById('edit-split');
const editSplitOutput = editSplitInput.nextElementSibling;
editSplitInput.addEventListener('input', () => {
  editSplitOutput.value = formatPercent(editSplitInput.value);
});

// Handle search
document.getElementById('searchExp').addEventListener('input', (e) => {
  const search = e.target.value.toLowerCase().trim();
  if (!search) {
    renderTable(experiments);
    return;
  }
  const filtered = experiments.filter(exp => 
    exp.id.toLowerCase().includes(search) ||
    exp.name.toLowerCase().includes(search)
  );
  renderTable(filtered);
});

// Handle refresh button
document.getElementById('refreshBtn').addEventListener('click', () => {
  fetchExperiments();
  fetchAllowedOrigins();
  fetchTeamMembers();
});

// Update system time
function updateSystemTime() {
  const timeEl = document.getElementById('systemTime');
  const now = new Date();
  timeEl.textContent = now.toLocaleString('en-US', { 
    dateStyle: 'medium', 
    timeStyle: 'long',
    timeZone: 'UTC'
  });
}

// Initialize datetime inputs
const startInput = document.getElementById('exp-start');
const stopInput = document.getElementById('exp-stop');
const editStartInput = document.getElementById('edit-start');
const editStopInput = document.getElementById('edit-stop');

initDateTimeInput(startInput);
initDateTimeInput(stopInput);
initDateTimeInput(editStartInput);
initDateTimeInput(editStopInput);

// Initialize
splitOutput.value = formatPercent(splitInput.value);
updateSystemTime();
setInterval(updateSystemTime, 1000);
(async function init() {
  await fetchCurrentAdmin();
  await Promise.all([fetchExperiments(), fetchAllowedOrigins(), fetchTeamMembers()]);
})();
