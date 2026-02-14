const API_BASE = window.location.origin + '/api/v1';

const state = {
  token: null,
  documents: [],
  selectedDocId: null,
  analysis: null,
  documentText: null,
  issues: [],
  activeTab: 'sequence',
  decisions: {},
};

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error?.message || data.error || 'Request failed');
  return data.data;
}

function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function showLoading(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  let overlay = panel.querySelector('.loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.innerHTML = '<div class="spinner"></div>';
    panel.style.position = 'relative';
    panel.appendChild(overlay);
  }
  overlay.classList.remove('hidden');
}

function hideLoading(panelId) {
  const overlay = document.getElementById(panelId)?.querySelector('.loading-overlay');
  if (overlay) overlay.classList.add('hidden');
}

async function init() {
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', handleLogin);
  document.getElementById('doc-select').addEventListener('change', handleDocSelect);
  document.getElementById('analyze-btn').addEventListener('click', runAnalysis);
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Login failed');
    state.token = data.data?.token || data.token;
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    await loadDocuments();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadDocuments() {
  try {
    const data = await api('/editorial/documents?limit=100');
    state.documents = data.documents || [];
    const select = document.getElementById('doc-select');
    select.innerHTML = '<option value="">Select a document...</option>';
    state.documents.forEach(doc => {
      const opt = document.createElement('option');
      opt.value = doc.id;
      opt.textContent = `${doc.originalName || doc.fileName} (${doc.counts?.citations || 0} citations)`;
      select.appendChild(opt);
    });
  } catch (err) {
    toast('Failed to load documents: ' + err.message, 'error');
  }
}

async function handleDocSelect(e) {
  const docId = e.target.value;
  if (!docId) return;
  state.selectedDocId = docId;
  state.decisions = {};
  await runAnalysis();
}

async function runAnalysis() {
  if (!state.selectedDocId) return;
  showLoading('doc-panel');
  showLoading('issues-panel');

  try {
    const [analysis, textData] = await Promise.all([
      api(`/citation/document/${state.selectedDocId}`),
      api(`/editorial/document/${state.selectedDocId}/text`).catch(() => ({ fullText: null })),
    ]);

    state.analysis = analysis;
    state.documentText = textData?.fullText || null;
    buildIssuesFromAnalysis();
    renderDocumentPanel();
    renderIssuesPanel();
  } catch (err) {
    toast('Analysis failed: ' + err.message, 'error');
  } finally {
    hideLoading('doc-panel');
    hideLoading('issues-panel');
  }
}

function buildIssuesFromAnalysis() {
  const issues = [];
  const a = state.analysis;
  if (!a) return;

  const seq = a.sequenceAnalysis;
  if (seq && !seq.isSequential) {
    if (seq.missingNumbers?.length > 0) {
      issues.push({
        id: 'seq-missing',
        category: 'sequence',
        severity: 'error',
        title: `${seq.missingNumbers.length} missing citation number(s)`,
        detail: `Expected continuous sequence from ${seq.expectedRange?.start} to ${seq.expectedRange?.end}. Missing: ${seq.missingNumbers.map(n => `[${n}]`).join(', ')}`,
        fixes: [
          { id: 'renumber', label: 'Renumber citations', desc: 'Renumber all citations sequentially to close gaps' },
          { id: 'add-missing', label: 'Flag for manual review', desc: 'Mark missing numbers for manual insertion' },
        ],
      });
    }
    if (seq.gaps?.length > 0) {
      seq.gaps.forEach((gap, i) => {
        issues.push({
          id: `seq-gap-${i}`,
          category: 'sequence',
          severity: 'warning',
          title: `Gap in sequence: [${gap.from}] to [${gap.to}]`,
          detail: `Jump from citation [${gap.from}] to [${gap.to}], skipping ${gap.to - gap.from - 1} number(s).`,
          fixes: [
            { id: 'renumber', label: 'Renumber to close gap', desc: 'Shift subsequent citations to fill the gap' },
            { id: 'ignore', label: 'Ignore', desc: 'No action needed — intentional gap' },
          ],
        });
      });
    }
    if (seq.duplicates?.length > 0) {
      issues.push({
        id: 'seq-dups',
        category: 'sequence',
        severity: 'error',
        title: `${seq.duplicates.length} duplicate citation number(s)`,
        detail: `Duplicated numbers: ${seq.duplicates.map(n => `[${n}]`).join(', ')}`,
        fixes: [
          { id: 'deduplicate', label: 'Deduplicate', desc: 'Assign unique numbers to duplicate citations' },
          { id: 'review', label: 'Review manually', desc: 'These may be intentional reuses' },
        ],
      });
    }
    if (seq.outOfOrder?.length > 0) {
      issues.push({
        id: 'seq-order',
        category: 'sequence',
        severity: 'warning',
        title: `${seq.outOfOrder.length} citation(s) out of order`,
        detail: `Citation numbers appearing out of sequential order.`,
        fixes: [
          { id: 'reorder', label: 'Reorder citations', desc: 'Sort citations by first appearance' },
          { id: 'ignore', label: 'Ignore', desc: 'Order may be intentional' },
        ],
      });
    }
  }

  const xref = a.crossReference;
  if (xref) {
    if (xref.citationsWithoutReference?.length > 0) {
      xref.citationsWithoutReference.forEach(cit => {
        issues.push({
          id: `xref-orphan-cit-${cit.number || cit.citationId}`,
          category: 'crossref',
          severity: 'error',
          title: `Citation [${cit.number || '?'}] has no matching reference`,
          detail: `Body citation "${escapeHtml(cit.text || '')}" does not match any entry in the reference list.`,
          fixes: [
            { id: 'add-ref', label: 'Add reference entry', desc: 'Create a reference list entry for this citation' },
            { id: 'remove-cit', label: 'Remove citation', desc: 'Delete this citation from the body text' },
            { id: 'flag', label: 'Flag for review', desc: 'Mark for manual resolution' },
          ],
        });
      });
    }
    if (xref.referencesWithoutCitation?.length > 0) {
      const count = xref.referencesWithoutCitation.length;
      issues.push({
        id: 'xref-uncited-refs',
        category: 'crossref',
        severity: 'warning',
        title: `${count} reference(s) not cited in body`,
        detail: `${count} entries in the reference list are not cited anywhere in the document body. First few: ${xref.referencesWithoutCitation.slice(0, 5).map(r => escapeHtml((r.text || '').slice(0, 60))).join('; ')}`,
        fixes: [
          { id: 'remove-uncited', label: 'Remove uncited references', desc: 'Delete reference entries that have no corresponding citation' },
          { id: 'keep', label: 'Keep all', desc: 'References may be intentionally included (e.g. further reading)' },
          { id: 'flag', label: 'Flag for review', desc: 'Mark for editorial review' },
        ],
      });
    }
  }

  state.issues = issues;
}

function renderDocumentPanel() {
  const body = document.querySelector('#doc-panel .panel-body');
  const a = state.analysis;

  if (!state.documentText && !a) {
    body.innerHTML = `<div class="empty-state"><h3>No Document Selected</h3><p>Choose a document from the dropdown above</p></div>`;
    return;
  }

  let html = '';

  if (a?.detectedStyle) {
    const s = a.detectedStyle;
    const confPct = Math.round(s.confidence * 100);
    const confColor = confPct >= 70 ? 'var(--green)' : confPct >= 40 ? 'var(--yellow)' : 'var(--red)';
    html += `<div class="style-badge">
      <span class="style-name">${escapeHtml(s.styleName)}</span>
      <div class="confidence-bar"><div class="confidence-fill" style="width:${confPct}%;background:${confColor}"></div></div>
      <span style="font-size:12px;color:var(--text-muted)">${confPct}%</span>
    </div>`;
  }

  if (a) {
    html += '<div class="stats-row">';
    html += `<div class="stat-chip"><span class="count">${a.citations?.totalCount || 0}</span> citations</div>`;
    html += `<div class="stat-chip"><span class="count">${a.referenceList?.totalEntries || 0}</span> references</div>`;
    html += `<div class="stat-chip"><span class="count">${a.crossReference?.matched || 0}</span> matched</div>`;
    const issueCount = state.issues.length;
    if (issueCount > 0) {
      html += `<div class="stat-chip" style="color:var(--red)"><span class="count" style="color:var(--red)">${issueCount}</span> issues</div>`;
    }
    html += '</div>';
  }

  if (state.documentText) {
    const highlighted = highlightCitations(state.documentText);
    html += `<div class="document-text-wrapper"><div class="document-text">${highlighted}</div></div>`;
  } else {
    html += `<div class="document-text" style="color:var(--text-muted);padding:20px;">
      Document source text is not available for inline display.\n\nThe analysis results and detected issues are shown in the panel on the right.
      ${a?.detectedStyle?.evidence?.length ? '\n\nDetection evidence:\n' + a.detectedStyle.evidence.map(e => '  - ' + escapeHtml(e)).join('\n') : ''}
    </div>`;
  }

  body.innerHTML = html;
}

function highlightCitations(text) {
  const a = state.analysis;
  if (!a) return escapeHtml(text);

  const matchedNums = new Set();
  const xref = a.crossReference;
  if (xref) {
    const orphanNums = new Set((xref.citationsWithoutReference || []).map(c => c.number));
    const bodyCount = xref.totalBodyCitations || 0;
    for (let i = 1; i <= (a.sequenceAnalysis?.expectedRange?.end || 0); i++) {
      if (!orphanNums.has(i)) matchedNums.add(i);
    }
  }

  const escaped = escapeHtml(text);
  return escaped.replace(/\[(\d{1,4})\]/g, (match, num) => {
    const n = parseInt(num, 10);
    const cls = matchedNums.has(n) ? 'matched' : 'issue';
    return `<span class="citation-highlight ${cls}" data-cit-num="${n}">${match}</span>`;
  });
}

function escapeHtml(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}

function renderIssuesPanel() {
  const body = document.querySelector('#issues-panel .panel-body');
  const a = state.analysis;

  if (!a) {
    body.innerHTML = '<div class="empty-state"><h3>No Analysis</h3><p>Select a document to analyze</p></div>';
    return;
  }

  const seqIssues = state.issues.filter(i => i.category === 'sequence');
  const xrefIssues = state.issues.filter(i => i.category === 'crossref');
  const refEntries = a.referenceList?.entries || [];

  let html = '';

  html += `<div class="issue-tabs">
    <button class="issue-tab ${state.activeTab === 'sequence' ? 'active' : ''}" data-tab="sequence">
      Sequence <span class="badge">${seqIssues.length}</span>
    </button>
    <button class="issue-tab ${state.activeTab === 'crossref' ? 'active' : ''}" data-tab="crossref">
      Cross-Ref <span class="badge">${xrefIssues.length}</span>
    </button>
    <button class="issue-tab ${state.activeTab === 'references' ? 'active' : ''}" data-tab="references">
      References <span class="badge">${refEntries.length}</span>
    </button>
    <button class="issue-tab ${state.activeTab === 'convert' ? 'active' : ''}" data-tab="convert">
      Convert
    </button>
  </div>`;

  html += `<div id="tab-sequence" class="issue-list ${state.activeTab !== 'sequence' ? 'hidden' : ''}">`;
  if (seqIssues.length === 0) {
    html += '<div class="empty-state"><h3>No Sequence Issues</h3><p>Citations are in proper sequence</p></div>';
  } else {
    html += renderBulkActions('sequence');
    seqIssues.forEach(issue => { html += renderIssueCard(issue); });
  }
  html += '</div>';

  html += `<div id="tab-crossref" class="issue-list ${state.activeTab !== 'crossref' ? 'hidden' : ''}">`;
  if (xrefIssues.length === 0) {
    html += '<div class="empty-state"><h3>No Cross-Reference Issues</h3><p>All citations match their references</p></div>';
  } else {
    html += renderBulkActions('crossref');
    xrefIssues.forEach(issue => { html += renderIssueCard(issue); });
  }
  html += '</div>';

  html += `<div id="tab-references" class="${state.activeTab !== 'references' ? 'hidden' : ''}">`;
  html += renderRefTable(refEntries);
  html += '</div>';

  html += `<div id="tab-convert" class="conversion-options ${state.activeTab !== 'convert' ? 'hidden' : ''}">`;
  const convOpts = a.conversionOptions || [];
  if (convOpts.length === 0) {
    html += '<div class="empty-state"><p>No conversion options available</p></div>';
  } else {
    const styleNames = { apa7: 'APA 7th Edition', mla9: 'MLA 9th Edition', chicago17: 'Chicago 17th', ieee: 'IEEE', vancouver: 'Vancouver' };
    convOpts.forEach(code => {
      html += `<div class="conversion-option">
        <span class="conversion-label">${escapeHtml(styleNames[code] || code)}</span>
        <button class="btn btn-sm btn-outline" onclick="requestConversion('${escapeHtml(code)}')">Convert</button>
      </div>`;
    });
  }
  html += '</div>';

  body.innerHTML = html;

  body.querySelectorAll('.issue-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  body.querySelectorAll('.issue-card-header').forEach(header => {
    header.addEventListener('click', () => toggleCard(header.closest('.issue-card')));
  });

  body.querySelectorAll('.fix-option').forEach(opt => {
    opt.addEventListener('click', () => selectFix(opt));
  });

  body.querySelectorAll('[data-action="accept"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      acceptIssue(btn.dataset.issueId);
    });
  });

  body.querySelectorAll('[data-action="reject"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      rejectIssue(btn.dataset.issueId);
    });
  });
}

function renderBulkActions(category) {
  const issues = state.issues.filter(i => i.category === category);
  const pending = issues.filter(i => !state.decisions[i.id]);
  if (pending.length === 0) return '';
  return `<div class="bulk-actions">
    <button class="btn btn-sm btn-success" onclick="bulkAccept('${category}')">Accept All (${pending.length})</button>
    <button class="btn btn-sm btn-outline" onclick="bulkReject('${category}')">Dismiss All</button>
  </div>`;
}

function renderIssueCard(issue) {
  const decision = state.decisions[issue.id];
  const statusClass = decision === 'accepted' ? 'accepted' : decision === 'rejected' ? 'rejected' : '';
  const statusBadge = decision === 'accepted' ? '<span class="accepted-badge">Accepted</span>' :
                      decision === 'rejected' ? '<span class="rejected-badge">Dismissed</span>' : '';

  let html = `<div class="issue-card ${statusClass}" data-issue-id="${escapeHtml(issue.id)}">
    <div class="issue-card-header">
      <div class="issue-severity ${issue.severity}"></div>
      <div style="flex:1">
        <div class="issue-title">${escapeHtml(issue.title)} ${statusBadge}</div>
      </div>
    </div>
    <div class="issue-card-body">
      <div class="issue-detail">${issue.detail}</div>`;

  if (!decision) {
    html += '<div class="section-label">Fix Options</div>';
    issue.fixes.forEach(fix => {
      html += `<div class="fix-option" data-fix-id="${escapeHtml(fix.id)}" data-issue-id="${escapeHtml(issue.id)}">
        <div class="fix-label">${escapeHtml(fix.label)}</div>
        <div class="fix-desc">${escapeHtml(fix.desc)}</div>
      </div>`;
    });

    html += `<div class="issue-actions" style="margin-top:10px">
      <button class="btn btn-sm btn-success" data-action="accept" data-issue-id="${escapeHtml(issue.id)}">Accept Fix</button>
      <button class="btn btn-sm btn-outline" data-action="reject" data-issue-id="${escapeHtml(issue.id)}">Dismiss</button>
    </div>`;
  }

  html += '</div></div>';
  return html;
}

function renderRefTable(entries) {
  if (entries.length === 0) return '<div class="empty-state"><p>No reference entries</p></div>';

  let html = '<table class="ref-table"><thead><tr><th>#</th><th>Status</th><th>Reference Text</th></tr></thead><tbody>';
  entries.forEach(entry => {
    html += `<tr>
      <td>${entry.number || entry.index + 1}</td>
      <td><span class="match-dot ${entry.hasMatch ? 'yes' : 'no'}"></span></td>
      <td>${escapeHtml((entry.text || '').slice(0, 120))}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  return html;
}

function switchTab(tab) {
  state.activeTab = tab;
  renderIssuesPanel();
}

function toggleCard(card) {
  card.classList.toggle('expanded');
}

function selectFix(opt) {
  const issueId = opt.dataset.issueId;
  opt.closest('.issue-card-body').querySelectorAll('.fix-option').forEach(o => o.classList.remove('selected'));
  opt.classList.add('selected');
}

function acceptIssue(issueId) {
  const card = document.querySelector(`[data-issue-id="${issueId}"]`);
  const selectedFix = card?.querySelector('.fix-option.selected');
  const fixId = selectedFix?.dataset.fixId || 'default';
  state.decisions[issueId] = 'accepted';
  toast(`Issue accepted — fix: ${fixId}`, 'success');
  renderIssuesPanel();
}

function rejectIssue(issueId) {
  state.decisions[issueId] = 'rejected';
  toast('Issue dismissed', 'info');
  renderIssuesPanel();
}

function bulkAccept(category) {
  state.issues.filter(i => i.category === category && !state.decisions[i.id]).forEach(issue => {
    state.decisions[issue.id] = 'accepted';
  });
  toast(`All ${category} issues accepted`, 'success');
  renderIssuesPanel();
}

function bulkReject(category) {
  state.issues.filter(i => i.category === category && !state.decisions[i.id]).forEach(issue => {
    state.decisions[issue.id] = 'rejected';
  });
  toast(`All ${category} issues dismissed`, 'info');
  renderIssuesPanel();
}

function requestConversion(styleCode) {
  toast(`Conversion to ${styleCode} requested — this feature is coming soon`, 'info');
}

document.addEventListener('DOMContentLoaded', init);
