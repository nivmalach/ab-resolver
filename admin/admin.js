// Admin Dashboard JavaScript
let experiments = [];

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
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  }) + ' UTC';
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
  const tbody = document.getElementById('expTableBody');
  tbody.innerHTML = '';
  
  const container = document.getElementById('experimentsTable');
  
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
  
  exps.forEach(exp => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div style="font-weight: 500;">${exp.id}</div>
        <small style="color: var(--gray-500);">Created ${formatDate(exp.created_at)}</small>
      </td>
      <td>${exp.name}</td>
      <td>
        <span class="status ${exp.status}">
          <span class="material-icons" style="font-size: 1rem;">
            ${exp.status === 'running' ? 'play_arrow' : 
              exp.status === 'stopped' ? 'stop' : 'pause'}
          </span>
          ${exp.status}
        </span>
      </td>
      <td>
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          <a href="#" onclick="forceVariant('${exp.id}', 'A'); return false;" 
             style="display: flex; align-items: center; gap: 0.25rem; color: var(--gray-700); text-decoration: none;">
            <span class="material-icons" style="font-size: 1rem;">radio_button_unchecked</span>
            Baseline
          </a>
          <a href="#" onclick="forceVariant('${exp.id}', 'B'); return false;"
             style="display: flex; align-items: center; gap: 0.25rem; color: var(--gray-700); text-decoration: none;">
            <span class="material-icons" style="font-size: 1rem;">change_history</span>
            Test
          </a>
        </div>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <div style="flex: 1; height: 4px; background: var(--gray-200); border-radius: 2px;">
            <div style="width: ${formatPercent(exp.allocation_b)}; height: 100%; background: var(--primary); border-radius: 2px;"></div>
          </div>
          <span style="color: var(--gray-600); font-size: 0.875rem;">${formatPercent(exp.allocation_b)}</span>
        </div>
      </td>
      <td>
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <div>
            <small style="color: var(--gray-500);">Start:</small>
            ${formatDate(exp.start_at)}
          </div>
          <div>
            <small style="color: var(--gray-500);">End:</small>
            ${formatDate(exp.stop_at)}
          </div>
        </div>
      </td>
      <td>
        <div class="button-group" style="display: flex; gap: 0.5rem;">
          ${exp.status !== 'running' ? `
            <button onclick="updateStatus('${exp.id}','running')" class="button primary" title="Start">
              <span class="material-icons">play_arrow</span>
            </button>
          ` : ''}
          ${exp.status === 'running' ? `
            <button onclick="updateStatus('${exp.id}','stopped')" class="button danger" title="Stop">
              <span class="material-icons">stop</span>
            </button>
          ` : ''}
          <button onclick="editExp('${exp.id}')" class="button" style="background: var(--gray-700); color: white;" title="Edit">
            <span class="material-icons">edit</span>
          </button>
          <button onclick="deleteExp('${exp.id}')" class="button danger" title="Delete">
            <span class="material-icons">delete</span>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Fetch and render experiments
async function fetchExperiments() {
  try {
    const res = await fetch('/experiments');
    experiments = await res.json();
    renderTable();
  } catch (err) {
    showToast('Failed to load experiments', 'error');
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
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  
  // Add generated ID
  data.id = generateId();
  
  // Format data
  data.allocation_b = parseFloat(data.allocation_b);
  data.preserve_params = data.preserve_params === 'on';
  
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
  form.elements.preserve_params.checked = exp.preserve_params;
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
  data.preserve_params = data.preserve_params === 'on';
  if (!data.start_at) delete data.start_at;
  if (!data.stop_at) delete data.stop_at;
  
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
fetchExperiments();