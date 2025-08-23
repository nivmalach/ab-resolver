async function fetchExperiments() {
  const res = await fetch('/experiments');
  const data = await res.json();
  renderTable(data);
}

function renderTable(exps) {
  const tbody = document.getElementById('expTableBody');
  tbody.innerHTML = '';
  exps.forEach(exp => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${exp.id}</td>
      <td>${exp.name}</td>
      <td>${exp.status}</td>
      <td><a href="${exp.baseline_url}" target="_blank">Baseline</a></td>
      <td><a href="${exp.test_url}" target="_blank">Test</a></td>
      <td>${exp.allocation_b}</td>
      <td>
        <button onclick="updateStatus('${exp.id}','running')">Start</button>
        <button onclick="updateStatus('${exp.id}','paused')">Pause</button>
        <button onclick="updateStatus('${exp.id}','stopped')">Stop</button>
        <button onclick="deleteExp('${exp.id}')">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function updateStatus(id, status) {
  await fetch(`/experiments/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  fetchExperiments();
}

async function deleteExp(id) {
  if (!confirm('Delete experiment ' + id + '?')) return;
  await fetch(`/experiments/${id}`, { method: 'DELETE' });
  fetchExperiments();
}

document.getElementById('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  data.allocation_b = parseFloat(data.allocation_b || 0.5);
  const res = await fetch('/experiments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) {
    form.reset();
    fetchExperiments();
  } else {
    alert('Error creating experiment');
  }
});

fetchExperiments();