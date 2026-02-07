const API_BASE = window.location.origin + '/api/v1';

const state = {
  token: localStorage.getItem('ninja_token') || null,
  documentId: null,
  analysis: null,
  documentText: null,
  documentHtml: null,
  referenceLookup: {},
  issues: [],
  activeTab: 'all',
  decisions: {},
  selectedFixId: {},
};

function getDocumentIdFromUrl() {
  const parts = window.location.pathname.split('/');
  const idx = parts.indexOf('citations');
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  return null;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (res.status === 401) {
    state.token = null;
    localStorage.removeItem('ninja_token');
    showAuth();
    throw new Error('Session expired');
  }
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
  setTimeout(() => el.remove(), 4000);
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

function showAuth() {
  document.getElementById('auth-gate').classList.remove('hidden');
  document.getElementById('main-app').classList.add('hidden');
}

function showApp() {
  document.getElementById('auth-gate').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
}

function init() {
  state.documentId = getDocumentIdFromUrl();

  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('register-form').addEventListener('submit', handleRegister);
  document.getElementById('show-register').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('register-screen').classList.remove('hidden');
  });
  document.getElementById('show-login').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  });
  document.getElementById('analyze-btn').addEventListener('click', runAnalysis);
  document.getElementById('upload-btn').addEventListener('click', showUploadModal);
  document.getElementById('cancel-upload').addEventListener('click', hideUploadModal);
  document.querySelector('.modal-backdrop')?.addEventListener('click', hideUploadModal);

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFileSelect(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFileSelect(e.target.files[0]); });

  if (state.token) {
    verifyTokenAndLoad();
  } else {
    showAuth();
  }
}

async function verifyTokenAndLoad() {
  try {
    await api('/auth/me');
    showApp();
    if (state.documentId) {
      await runAnalysis();
    } else {
      renderNoDocument();
    }
  } catch {
    state.token = null;
    localStorage.removeItem('ninja_token');
    showAuth();
  }
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
    localStorage.setItem('ninja_token', state.token);
    showApp();
    if (state.documentId) await runAnalysis();
    else renderNoDocument();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;
  try {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Registration failed');
    state.token = data.data?.token || data.token;
    localStorage.setItem('ninja_token', state.token);
    toast('Account created successfully', 'success');
    showApp();
    if (state.documentId) await runAnalysis();
    else renderNoDocument();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderNoDocument() {
  document.querySelector('#doc-panel .panel-body').innerHTML = `<div class="empty-state">
    <h3>No Document Selected</h3>
    <p>Use "Upload New" to upload a document for citation analysis.</p>
  </div>`;
  document.querySelector('#issues-panel .panel-body').innerHTML = `<div class="empty-state">
    <h3>No Analysis</h3>
    <p>Upload a document to get started</p>
  </div>`;
}

async function runAnalysis() {
  if (!state.documentId) return;
  showLoading('doc-panel');
  showLoading('issues-panel');
  document.getElementById('doc-info').textContent = `Document: ${state.documentId.slice(0, 8)}...`;

  try {
    const [analysis, textData, refLookup] = await Promise.all([
      api(`/citation/document/${state.documentId}`),
      api(`/editorial/document/${state.documentId}/text`).catch(() => null),
      api(`/editorial/document/${state.documentId}/reference-lookup`).catch(() => null),
    ]);
    state.analysis = analysis;
    state.documentText = textData?.fullText || null;
    state.documentHtml = textData?.fullHtml || null;
    state.referenceLookup = refLookup?.referenceLookup || {};
    buildIssuesFromAnalysis();
    state.activeTab = state.issues.length > 0 ? 'all' : 'references';
    renderDocumentPanel();
    renderIssuesPanel();
  } catch (err) {
    toast('Analysis failed: ' + err.message, 'error');
    document.querySelector('#doc-panel .panel-body').innerHTML = `<div class="empty-state">
      <h3>Analysis Failed</h3>
      <p>${escapeHtml(err.message)}</p>
      <p style="margin-top:12px">Try uploading the document using "Upload New".</p>
    </div>`;
  } finally {
    hideLoading('doc-panel');
    hideLoading('issues-panel');
  }
}

function showUploadModal() {
  document.getElementById('upload-modal').classList.remove('hidden');
  document.getElementById('upload-progress').classList.add('hidden');
  document.getElementById('file-input').value = '';
}

function hideUploadModal() {
  document.getElementById('upload-modal').classList.add('hidden');
}

async function handleFileSelect(file) {
  if (!file) return;
  const allowed = ['pdf', 'docx', 'txt', 'epub'];
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!allowed.includes(ext)) {
    toast('Unsupported file type. Use PDF, DOCX, TXT, or EPUB.', 'error');
    return;
  }
  const progressDiv = document.getElementById('upload-progress');
  const progressFill = document.getElementById('progress-fill');
  const statusText = document.getElementById('upload-status');
  progressDiv.classList.remove('hidden');
  progressFill.style.width = '30%';
  statusText.textContent = `Uploading ${file.name}...`;

  try {
    const formData = new FormData();
    formData.append('file', file);
    progressFill.style.width = '50%';
    statusText.textContent = 'Analyzing citations...';

    const res = await fetch(`${API_BASE}/citation/detect`, {
      method: 'POST',
      headers: state.token ? { 'Authorization': `Bearer ${state.token}` } : {},
      body: formData,
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error?.message || 'Upload failed');

    progressFill.style.width = '100%';
    statusText.textContent = 'Analysis complete!';
    const result = data.data;

    if (result.documentId) {
      state.documentId = result.documentId;
      window.history.pushState({}, '', `/editorial/citations/${result.documentId}`);
      state.analysis = result;
      state.decisions = {};
      state.selectedFixId = {};
      try {
        const [textData, refLookup] = await Promise.all([
          api(`/editorial/document/${result.documentId}/text`),
          api(`/editorial/document/${result.documentId}/reference-lookup`).catch(() => null),
        ]);
        state.documentText = textData?.fullText || null;
        state.documentHtml = textData?.fullHtml || null;
        state.referenceLookup = refLookup?.referenceLookup || {};
      } catch {
        state.documentText = null;
        state.documentHtml = null;
        state.referenceLookup = {};
      }
      buildIssuesFromAnalysis();
      state.activeTab = state.issues.length > 0 ? 'all' : 'references';
      renderDocumentPanel();
      renderIssuesPanel();
      document.getElementById('doc-info').textContent = `Document: ${escapeHtml(file.name)}`;
      toast('Document analyzed successfully', 'success');
    }
    setTimeout(hideUploadModal, 600);
  } catch (err) {
    toast('Upload failed: ' + err.message, 'error');
    progressFill.style.width = '0%';
    statusText.textContent = 'Failed';
  }
}

function buildIssuesFromAnalysis() {
  const issues = [];
  const a = state.analysis;
  if (!a) return;

  const seq = a.sequenceAnalysis;
  if (seq) {
    if (seq.missingNumbers?.length > 0) {
      issues.push({
        id: 'seq-missing', category: 'sequence', severity: 'error',
        title: `${seq.missingNumbers.length} missing citation number(s)`,
        detail: `Expected continuous sequence ${seq.expectedRange?.start}-${seq.expectedRange?.end}. Missing: ${seq.missingNumbers.map(n => '[' + n + ']').join(', ')}`,
        fixes: [
          { id: 'renumber', label: 'Renumber citations sequentially', desc: 'Close gaps by renumbering all citations' },
          { id: 'flag', label: 'Flag for manual review', desc: 'Mark missing numbers for manual insertion' },
        ],
      });
    }
    if (seq.gaps?.length > 0) {
      seq.gaps.forEach((gap, i) => {
        issues.push({
          id: `seq-gap-${i}`, category: 'sequence', severity: 'warning',
          title: `Gap: [${gap.from}] to [${gap.to}]`,
          detail: `Jump from [${gap.from}] to [${gap.to}], skipping ${gap.to - gap.from - 1} number(s).`,
          fixes: [
            { id: 'renumber', label: 'Renumber to close gap', desc: 'Shift subsequent citations' },
            { id: 'ignore', label: 'Ignore', desc: 'Intentional gap' },
          ],
        });
      });
    }
    if (seq.duplicates?.length > 0) {
      issues.push({
        id: 'seq-dups', category: 'sequence', severity: 'error',
        title: `${seq.duplicates.length} duplicate citation number(s)`,
        detail: `Duplicated: ${seq.duplicates.map(n => '[' + n + ']').join(', ')}`,
        fixes: [
          { id: 'deduplicate', label: 'Deduplicate', desc: 'Assign unique numbers' },
          { id: 'review', label: 'Review manually', desc: 'May be intentional reuses' },
        ],
      });
    }
    if (seq.outOfOrder?.length > 0) {
      issues.push({
        id: 'seq-order', category: 'sequence', severity: 'warning',
        title: `${seq.outOfOrder.length} citation(s) out of order`,
        detail: 'Citation numbers appear out of sequential order in the text.',
        fixes: [
          { id: 'reorder', label: 'Reorder by first appearance', desc: 'Renumber based on order in text' },
          { id: 'ignore', label: 'Ignore', desc: 'Order may be intentional' },
        ],
      });
    }
  }

  const xref = a.crossReference;
  if (xref) {
    if (xref.citationsWithoutReference?.length > 0) {
      xref.citationsWithoutReference.forEach(cit => {
        const num = cit.number || '?';
        issues.push({
          id: `xref-orphan-${num}`, category: 'crossref', severity: 'error',
          title: `Citation [${num}] has no matching reference`,
          detail: `"${escapeHtml((cit.text || '').slice(0, 100))}" is not found in the reference list.`,
          fixes: [
            { id: 'add-ref', label: 'Add reference entry', desc: 'Create a reference list entry' },
            { id: 'remove-cit', label: 'Remove citation', desc: 'Delete from body text' },
            { id: 'flag', label: 'Flag for review', desc: 'Mark for manual check' },
          ],
        });
      });
    }
    if (xref.referencesWithoutCitation?.length > 0) {
      const count = xref.referencesWithoutCitation.length;
      issues.push({
        id: 'xref-uncited', category: 'crossref', severity: 'warning',
        title: `${count} reference(s) not cited in body`,
        detail: `These reference entries have no matching in-text citation: ${xref.referencesWithoutCitation.slice(0, 3).map(r => escapeHtml((r.text || '').slice(0, 50))).join('; ')}${count > 3 ? '...' : ''}`,
        fixes: [
          { id: 'remove-uncited', label: 'Remove uncited references', desc: 'Delete entries without citations' },
          { id: 'keep', label: 'Keep all', desc: 'May be further reading' },
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
    body.innerHTML = '<div class="empty-state"><h3>No Document</h3><p>Upload a document to get started</p></div>';
    return;
  }

  let html = '';

  if (a?.detectedStyle) {
    const s = a.detectedStyle;
    const confPct = Math.round(s.confidence * 100);
    const confColor = confPct >= 70 ? 'var(--green)' : confPct >= 40 ? 'var(--yellow)' : 'var(--red)';
    html += `<div class="style-badge">
      <span class="style-name">${escapeHtml(s.styleName || s.styleCode || 'Unknown')}</span>
      <div class="confidence-bar"><div class="confidence-fill" style="width:${confPct}%;background:${confColor}"></div></div>
      <span style="font-size:12px;color:var(--text-muted)">${confPct}% confidence</span>
    </div>`;
  }

  if (a) {
    html += '<div class="stats-row">';
    html += `<div class="stat-chip"><span class="count">${a.citations?.totalCount || 0}</span> citations</div>`;
    html += `<div class="stat-chip"><span class="count">${a.referenceList?.totalEntries || 0}</span> references</div>`;
    html += `<div class="stat-chip"><span class="count">${a.crossReference?.matched || 0}</span> matched</div>`;
    if (state.issues.length > 0) {
      html += `<div class="stat-chip issue-chip"><span class="count" style="color:var(--red)">${state.issues.length}</span> issues</div>`;
    }
    html += '</div>';
  }

  if (state.documentHtml) {
    html += renderHtmlEditorView(state.documentHtml);
  } else if (state.documentText) {
    html += renderEditorView(state.documentText);
  } else if (a?.citations?.items?.length > 0) {
    html += '<div class="section-label" style="padding:12px 16px 4px">Detected Citations</div>';
    html += '<div class="citation-list">';
    a.citations.items.forEach((cit, i) => {
      const hasRef = !state.issues.find(iss => iss.id === `xref-orphan-${cit.number || i}`);
      html += `<div class="citation-item ${hasRef ? 'matched' : 'orphan'}">
        <span class="cit-num">[${cit.number || i + 1}]</span>
        <span class="cit-text">${escapeHtml((cit.text || cit.rawText || '').slice(0, 120))}</span>
        <span class="cit-status">${hasRef ? 'Matched' : 'No ref'}</span>
      </div>`;
    });
    html += '</div>';
  } else {
    html += `<div class="empty-state" style="padding:40px 20px">
      <p>Document source text not available for inline display.</p>
      <p style="margin-top:8px">Analysis results and issues are shown in the right panel.</p>
    </div>`;
  }

  body.innerHTML = html;
  const styledHtmlEl = document.getElementById('styled-html-content');
  if (styledHtmlEl) {
    highlightCitationsInDom(styledHtmlEl);
  }
  initCitationTooltips(body);
}

function initCitationTooltips(container) {
  let tooltip = document.getElementById('citation-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'citation-tooltip';
    tooltip.className = 'citation-tooltip';
    document.body.appendChild(tooltip);
  }

  container.querySelectorAll('.citation-highlight[data-cit-num]').forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      const num = el.dataset.citNum;
      const cls = el.classList.contains('matched') ? 'matched' : 'issue';
      const text = getTooltipText(parseInt(num, 10), cls);
      tooltip.innerHTML = `<div class="tooltip-header">[${escapeHtml(num)}]</div><div class="tooltip-body">${escapeHtml(text)}</div>`;
      tooltip.classList.add('visible');
      tooltip.classList.toggle('tooltip-matched', cls === 'matched');
      tooltip.classList.toggle('tooltip-issue', cls === 'issue');
      positionTooltip(tooltip, e);
    });
    el.addEventListener('mousemove', (e) => {
      positionTooltip(tooltip, e);
    });
    el.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });
  });
}

function positionTooltip(tooltip, e) {
  const pad = 12;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - pad) {
    x = e.clientX - rect.width - pad;
  }
  if (y + rect.height > window.innerHeight - pad) {
    y = e.clientY - rect.height - pad;
  }
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

function getMatchedNums() {
  const a = state.analysis;
  const matchedNums = new Set();
  if (a?.crossReference) {
    const orphanNums = new Set((a.crossReference.citationsWithoutReference || []).map(c => c.number));
    const maxFromSeq = a.sequenceAnalysis?.expectedRange?.end || 0;
    if (maxFromSeq > 0) {
      for (let i = 1; i <= maxFromSeq; i++) {
        if (!orphanNums.has(i)) matchedNums.add(i);
      }
    }
    Object.keys(state.referenceLookup).forEach(key => {
      const n = parseInt(key, 10);
      if (!isNaN(n) && !orphanNums.has(n)) matchedNums.add(n);
    });
    const refEntries = a.referenceList?.entries || [];
    refEntries.forEach(entry => {
      const n = entry.number || (entry.index != null ? entry.index + 1 : null);
      if (n && !orphanNums.has(n)) matchedNums.add(n);
    });
  }
  return matchedNums;
}

function getTooltipText(n, cls) {
  const refText = state.referenceLookup[String(n)];
  if (refText) {
    return refText.length > 200 ? refText.slice(0, 200) + '...' : refText;
  }
  return cls === 'matched' ? `Citation [${n}] — has reference` : `Citation [${n}] — no matching reference`;
}

function highlightCitationsInDom(container) {
  const matchedNums = getMatchedNums();
  const knownNums = new Set();
  Object.keys(state.referenceLookup).forEach(k => {
    const n = parseInt(k, 10);
    if (!isNaN(n)) knownNums.add(n);
  });
  const a = state.analysis;
  if (a?.referenceList?.entries) {
    a.referenceList.entries.forEach(entry => {
      const n = entry.number || (entry.index != null ? entry.index + 1 : null);
      if (n) knownNums.add(n);
    });
  }
  const maxNum = Math.max(
    a?.sequenceAnalysis?.expectedRange?.end || 0,
    ...[...knownNums],
    a?.citations?.totalCount || 0
  ) || 200;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const bracketRe = /\[(\d{1,4})\]/g;
  const parenRe = /\((\d{1,4}(?:\s*,\s*\d{1,4})*)\)/g;

  textNodes.forEach(node => {
    const text = node.textContent;
    if (!text || text.trim().length === 0) return;

    const hasBracket = bracketRe.test(text);
    bracketRe.lastIndex = 0;
    const hasParen = parenRe.test(text);
    parenRe.lastIndex = 0;

    if (!hasBracket && !hasParen) return;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    const combinedRe = /\[(\d{1,4})\]|\((\d{1,4}(?:\s*,\s*\d{1,4})*)\)/g;
    let m;

    while ((m = combinedRe.exec(text)) !== null) {
      const bracketNum = m[1];
      const parenNums = m[2];

      let nums = [];
      if (bracketNum) {
        nums = [parseInt(bracketNum, 10)];
      } else if (parenNums) {
        nums = parenNums.split(/\s*,\s*/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      }

      const validNums = nums.filter(n => n >= 1 && n <= maxNum);
      if (validNums.length === 0) continue;

      if (m.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }

      const span = document.createElement('span');
      const firstNum = validNums[0];
      const cls = matchedNums.has(firstNum) || knownNums.has(firstNum) ? 'matched' : 'issue';
      span.className = `citation-highlight ${cls}`;
      span.dataset.citNum = String(firstNum);
      span.textContent = m[0];
      frag.appendChild(span);

      lastIdx = combinedRe.lastIndex;
    }

    if (lastIdx === 0) return;

    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }

    node.parentNode.replaceChild(frag, node);
  });
}

function renderHtmlEditorView(html) {
  return `<div class="editor-wrapper html-editor">
    <div class="editor-content styled-html" id="styled-html-content">${html}</div>
  </div>`;
}

function renderEditorView(text) {
  const lines = text.split('\n');
  const matchedNums = getMatchedNums();
  const knownNums = new Set();
  Object.keys(state.referenceLookup).forEach(k => {
    const n = parseInt(k, 10);
    if (!isNaN(n)) knownNums.add(n);
  });
  const a = state.analysis;
  const maxNum = Math.max(
    a?.sequenceAnalysis?.expectedRange?.end || 0,
    ...[...knownNums],
    a?.citations?.totalCount || 0
  ) || 200;

  let lineNumsHtml = '';
  let contentHtml = '';
  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    lineNumsHtml += `<div class="ln">${lineNum}</div>`;
    const escaped = escapeHtml(line);
    const highlighted = escaped.replace(/\[(\d{1,4})\]|\((\d{1,4}(?:\s*,\s*\d{1,4})*)\)/g, (match, bracketNum, parenNums) => {
      if (bracketNum) {
        const n = parseInt(bracketNum, 10);
        const cls = matchedNums.has(n) || knownNums.has(n) ? 'matched' : 'issue';
        return `<span class="citation-highlight ${cls}" data-cit-num="${n}">${match}</span>`;
      }
      if (parenNums) {
        const nums = parenNums.split(/\s*,\s*/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        const valid = nums.filter(n => n >= 1 && n <= maxNum);
        if (valid.length === 0) return match;
        const firstNum = valid[0];
        const cls = matchedNums.has(firstNum) || knownNums.has(firstNum) ? 'matched' : 'issue';
        return `<span class="citation-highlight ${cls}" data-cit-num="${firstNum}">${match}</span>`;
      }
      return match;
    });
    contentHtml += `<div class="editor-line" data-line="${lineNum}">${highlighted || '&nbsp;'}</div>`;
  });

  return `<div class="editor-wrapper">
    <div class="editor-gutter">${lineNumsHtml}</div>
    <div class="editor-content">${contentHtml}</div>
  </div>`;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}

function renderIssuesPanel() {
  const body = document.querySelector('#issues-panel .panel-body');
  const a = state.analysis;

  if (!a) {
    body.innerHTML = '<div class="empty-state"><h3>No Analysis</h3><p>Upload a document to analyze</p></div>';
    return;
  }

  const seqIssues = state.issues.filter(i => i.category === 'sequence');
  const xrefIssues = state.issues.filter(i => i.category === 'crossref');
  const allIssues = state.issues;
  const refEntries = a.referenceList?.entries || [];

  let html = `<div class="issue-tabs">
    <button class="issue-tab ${state.activeTab === 'all' ? 'active' : ''}" data-tab="all">
      All Issues <span class="badge">${allIssues.length}</span>
    </button>
    <button class="issue-tab ${state.activeTab === 'references' ? 'active' : ''}" data-tab="references">
      References <span class="badge">${refEntries.length}</span>
    </button>
    <button class="issue-tab ${state.activeTab === 'convert' ? 'active' : ''}" data-tab="convert">
      Convert
    </button>
  </div>`;

  html += `<div id="tab-all" class="issue-list ${state.activeTab !== 'all' ? 'hidden' : ''}">`;
  if (allIssues.length === 0) {
    html += '<div class="empty-state"><h3>No Issues Found</h3><p>All citations and references look good.</p></div>';
  } else {
    const pending = allIssues.filter(i => !state.decisions[i.id]).length;
    if (pending > 0) {
      html += `<div class="bulk-actions">
        <span style="font-size:12px;color:var(--text-muted)">${pending} issue(s) pending</span>
        <button class="btn btn-sm btn-success" onclick="bulkAccept('all')">Accept All Fixes</button>
        <button class="btn btn-sm btn-outline" onclick="bulkReject('all')">Dismiss All</button>
      </div>`;
    }
    allIssues.forEach(issue => { html += renderIssueCard(issue); });
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
  body.querySelectorAll('.fix-option').forEach(opt => {
    opt.addEventListener('click', () => selectFix(opt));
  });
  body.querySelectorAll('[data-action="accept"]').forEach(btn => {
    btn.addEventListener('click', () => acceptIssue(btn.dataset.issueId));
  });
  body.querySelectorAll('[data-action="reject"]').forEach(btn => {
    btn.addEventListener('click', () => rejectIssue(btn.dataset.issueId));
  });
}

function renderIssueCard(issue) {
  const decision = state.decisions[issue.id];
  const statusClass = decision === 'accepted' ? 'accepted' : decision === 'rejected' ? 'rejected' : '';
  const statusBadge = decision === 'accepted' ? '<span class="accepted-badge">Accepted</span>' :
                      decision === 'rejected' ? '<span class="rejected-badge">Dismissed</span>' : '';
  const sevIcon = issue.severity === 'error' ? 'E' : 'W';
  const sevColor = issue.severity === 'error' ? 'var(--red)' : 'var(--yellow)';

  let html = `<div class="issue-card expanded ${statusClass}" data-issue-id="${escapeHtml(issue.id)}">
    <div class="issue-card-header">
      <div class="sev-icon" style="background:${sevColor}">${sevIcon}</div>
      <div style="flex:1">
        <div class="issue-title">${escapeHtml(issue.title)} ${statusBadge}</div>
        <div class="issue-detail">${issue.detail}</div>
      </div>
    </div>`;

  if (!decision) {
    html += '<div class="issue-card-body">';
    html += '<div class="fix-options-label">Suggested Fixes:</div>';
    issue.fixes.forEach((fix, idx) => {
      const isSelected = (state.selectedFixId[issue.id] || issue.fixes[0].id) === fix.id;
      html += `<div class="fix-option ${isSelected ? 'selected' : ''}" data-fix-id="${escapeHtml(fix.id)}" data-issue-id="${escapeHtml(issue.id)}">
        <div class="fix-radio">${isSelected ? '<div class="fix-radio-dot"></div>' : ''}</div>
        <div>
          <div class="fix-label">${escapeHtml(fix.label)}</div>
          <div class="fix-desc">${escapeHtml(fix.desc)}</div>
        </div>
      </div>`;
    });
    html += `<div class="issue-actions">
      <button class="btn btn-sm btn-success" data-action="accept" data-issue-id="${escapeHtml(issue.id)}">Accept Fix</button>
      <button class="btn btn-sm btn-outline" data-action="reject" data-issue-id="${escapeHtml(issue.id)}">Dismiss</button>
    </div>`;
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function renderRefTable(entries) {
  if (!entries || entries.length === 0) return '<div class="empty-state"><p>No reference entries found</p></div>';
  let html = '<table class="ref-table"><thead><tr><th>#</th><th>Status</th><th>Reference Text</th></tr></thead><tbody>';
  entries.forEach(entry => {
    const num = entry.number || (entry.index != null ? entry.index + 1 : '?');
    html += `<tr>
      <td>${num}</td>
      <td><span class="match-dot ${entry.hasMatch ? 'yes' : 'no'}"></span> ${entry.hasMatch ? 'Cited' : 'Uncited'}</td>
      <td>${escapeHtml((entry.text || '').slice(0, 150))}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  return html;
}

function switchTab(tab) {
  state.activeTab = tab;
  renderIssuesPanel();
}

function selectFix(opt) {
  const issueId = opt.dataset.issueId;
  const fixId = opt.dataset.fixId;
  state.selectedFixId[issueId] = fixId;
  renderIssuesPanel();
}

function acceptIssue(issueId) {
  const fixId = state.selectedFixId[issueId] || state.issues.find(i => i.id === issueId)?.fixes[0]?.id || 'default';
  state.decisions[issueId] = 'accepted';
  toast(`Fix accepted: ${fixId}`, 'success');
  renderIssuesPanel();
  renderDocumentPanel();
}

function rejectIssue(issueId) {
  state.decisions[issueId] = 'rejected';
  toast('Issue dismissed', 'info');
  renderIssuesPanel();
}

function bulkAccept(category) {
  const targets = category === 'all' ? state.issues : state.issues.filter(i => i.category === category);
  targets.filter(i => !state.decisions[i.id]).forEach(issue => {
    state.decisions[issue.id] = 'accepted';
  });
  toast(`All issues accepted`, 'success');
  renderIssuesPanel();
  renderDocumentPanel();
}

function bulkReject(category) {
  const targets = category === 'all' ? state.issues : state.issues.filter(i => i.category === category);
  targets.filter(i => !state.decisions[i.id]).forEach(issue => {
    state.decisions[issue.id] = 'rejected';
  });
  toast('All issues dismissed', 'info');
  renderIssuesPanel();
}

function requestConversion(styleCode) {
  toast(`Conversion to ${styleCode} requested — coming soon`, 'info');
}

document.addEventListener('DOMContentLoaded', init);
