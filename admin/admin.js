// Admin Dashboard JavaScript
let experiments = [];

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
    day: 'numeric'
  });
}

// Format percentage
function formatPercent(num) {
  return (num * 100).toFixed(0) + '%';
}

// Render experiments table
function renderTable(exps = experiments) {
  const tbody = document.getElementById('expTableBody');
  tbody.innerHTML = '';
  
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
              exp.status === 'paused' ? 'pause' : 'stop'}
          </span>
          ${exp.status}
        </span>
      </td>
      <td>
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          <a href="${exp.baseline_url}" target="_blank" style="display: flex; align-items: center; gap: 0.25rem; color: var(--gray-700); text-decoration: none;">
            <span class="material-icons" style="font-size: 1rem;">radio_button_unchecked</span>
            Baseline
          </a>
          <a href="${exp.test_url}" target="_blank" style="display: flex; align-items: center; gap: 0.25rem; color: var(--gray-700); text-decoration: none;">
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
            <button onclick="updateStatus('${exp.id}','paused')" class="button" style="background: var(--warning); color: white;" title="Pause">
              <span class="material-icons">pause</span>
            </button>
          ` : ''}
          ${exp.status !== 'stopped' ? `
            <button onclick="updateStatus('${exp.id}','stopped')" class="button danger" title="Stop">
              <span class="material-icons">stop</span>
            </button>
          ` : ''}
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
  
  // Format data
  data.allocation_b = parseFloat(data.allocation_b);
  data.preserve_params = data.preserve_params === 'true';
  
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

// Handle split ratio input
const splitInput = document.getElementById('exp-split');
const splitOutput = splitInput.nextElementSibling;
splitInput.addEventListener('input', () => {
  splitOutput.value = formatPercent(splitInput.value);
});

// Handle search
document.getElementById('searchExp').addEventListener('input', (e) => {
  const search = e.target.value.toLowerCase();
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

// Initialize
splitOutput.value = formatPercent(splitInput.value);
fetchExperiments();