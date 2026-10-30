import { useState, useEffect, useRef, useCallback } from 'react';
import { HashRouter, Routes, Route, useNavigate, useParams, Link } from 'react-router-dom';
import { ToastProvider, useToast, useGroups, useExpenses, useOCR, useCamera } from './hooks/useAppHooks';
import { parseReceipt, validateTotal, formatRupees } from './logic/receiptParser';
import { calculateItemizedSplit, calculateEqualSplit, calculatePercentageSplit, calculateSharesSplit, computeNetBalances } from './logic/splitEngine';
import { simplifyDebts } from './logic/debtSimplifier';
import { formatCurrency, formatDate, formatRelativeTime, getInitials, getMemberColor, CATEGORIES, generateUPILink } from './utils/formatters';
import { preprocessImage, rotateImage, readFileAsDataUrl } from './utils/imagePreprocess';
import { generateId } from './db/database';
import * as dbOps from './db/database';
import './index.css';

// ===== MAIN APP =====
export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <Navbar />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/group/:groupId" element={<GroupView />} />
          <Route path="/group/:groupId/scan" element={<ReceiptScanner />} />
          <Route path="/group/:groupId/manual" element={<ManualExpense />} />
          <Route path="/group/:groupId/review" element={<ReviewEditor />} />
        </Routes>
      </ToastProvider>
    </HashRouter>
  );
}

// ===== NAVBAR =====
function Navbar() {
  return (
    <nav className="navbar">
      <Link to="/" className="navbar-brand" style={{ textDecoration: 'none', color: 'inherit' }}>
        <span className="navbar-brand-icon">💰</span>
        <span className="gradient-text">SplitSmart</span>
      </Link>
      <div className="navbar-actions">
        <ExportImportButton />
      </div>
    </nav>
  );
}

function ExportImportButton() {
  const [showMenu, setShowMenu] = useState(false);
  const toast = useToast();
  const fileRef = useRef(null);

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await dbOps.importGroupData(data);
      toast('Group imported successfully!', 'success');
      window.location.reload();
    } catch (err) {
      toast('Failed to import: ' + err.message, 'error');
    }
    setShowMenu(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-ghost btn-icon" onClick={() => setShowMenu(!showMenu)} title="Import/Export">
        ⚙️
      </button>
      {showMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setShowMenu(false)} />
          <div style={{
            position: 'absolute', right: 0, top: '100%', marginTop: 8,
            background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
            borderRadius: 'var(--radius-md)', padding: 8, minWidth: 180, zIndex: 100,
            boxShadow: 'var(--shadow-lg)'
          }}>
            <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => { fileRef.current?.click(); }}>
              📥 Import Group JSON
            </button>
            <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImport} />
          </div>
        </>
      )}
    </div>
  );
}

// ===== DASHBOARD =====
function Dashboard() {
  const { groups, loading, createGroup, deleteGroup } = useGroups();
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  if (loading) return <LoadingScreen />;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">
          <span className="gradient-text">Your Groups</span>
        </h1>
        <p className="page-subtitle">Manage shared expenses with your friends</p>
      </div>

      {groups.length === 0 ? (
        <div className="empty-state animate-fadeIn">
          <span className="empty-state-icon">👥</span>
          <h3 className="empty-state-title">No groups yet</h3>
          <p className="empty-state-text">Create your first group to start splitting expenses</p>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            ➕ Create Group
          </button>
        </div>
      ) : (
        <div className="stagger-children" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {groups.map(group => (
            <GroupCard key={group.id} group={group} onClick={() => navigate(`/group/${group.id}`)}
              onDelete={() => { deleteGroup(group.id); toast('Group deleted', 'info'); }} />
          ))}
          <div className="glass-card" style={{ padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160, cursor: 'pointer' }}
            onClick={() => setShowCreate(true)}>
            <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
              <span style={{ fontSize: '2rem', display: 'block', marginBottom: 8 }}>➕</span>
              <span style={{ fontWeight: 600 }}>New Group</span>
            </div>
          </div>
        </div>
      )}

      {showCreate && <CreateGroupModal onClose={() => setShowCreate(false)} onCreate={async (name, members) => {
        const group = await createGroup(name, members);
        toast('Group created!', 'success');
        setShowCreate(false);
        navigate(`/group/${group.id}`);
      }} />}
    </div>
  );
}

function GroupCard({ group, onClick, onDelete }) {
  const [expenseCount, setExpenseCount] = useState(0);

  useEffect(() => {
    dbOps.getExpensesByGroup(group.id).then(e => setExpenseCount(e.length));
  }, [group.id]);

  return (
    <div className="glass-card group-card" onClick={onClick}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="group-card-name">{group.name}</div>
        <button className="btn btn-ghost btn-icon" style={{ marginTop: -4, marginRight: -4, fontSize: '0.8rem' }}
          onClick={e => { e.stopPropagation(); if (confirm('Delete this group?')) onDelete(); }}>
          🗑️
        </button>
      </div>
      <div className="group-card-meta">
        {group.members?.length || 0} members · {expenseCount} expenses
      </div>
      <div className="avatar-stack" style={{ marginBottom: 8 }}>
        {(group.members || []).slice(0, 5).map((m, i) => (
          <div key={m.id} className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }}>
            {getInitials(m.name)}
          </div>
        ))}
        {(group.members?.length || 0) > 5 && (
          <div className="avatar avatar-sm" style={{ background: 'var(--bg-tertiary)', fontSize: '0.6rem' }}>
            +{group.members.length - 5}
          </div>
        )}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        Updated {formatRelativeTime(group.updatedAt)}
      </div>
    </div>
  );
}

// ===== CREATE GROUP MODAL =====
function CreateGroupModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState([]);
  const [memberName, setMemberName] = useState('');

  const addMember = () => {
    if (!memberName.trim()) return;
    setMembers([...members, {
      id: generateId(),
      name: memberName.trim(),
      color: getMemberColor(members.length),
    }]);
    setMemberName('');
  };

  const removeMember = (id) => {
    setMembers(members.filter(m => m.id !== id));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Create Group</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div>
            <label className="label">Group Name</label>
            <input className="input" placeholder="e.g., Night Canteen Gang" value={name}
              onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Members</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" placeholder="Member name" value={memberName}
                onChange={e => setMemberName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addMember(); }} />
              <button className="btn btn-secondary" onClick={addMember}>Add</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {members.map(m => (
                <span key={m.id} className="badge badge-violet" style={{ gap: 6, cursor: 'pointer' }}
                  onClick={() => removeMember(m.id)}>
                  <span className="avatar avatar-sm" style={{ background: m.color, width: 20, height: 20, fontSize: '0.55rem' }}>
                    {getInitials(m.name)}
                  </span>
                  {m.name} ✕
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || members.length < 2}
            onClick={() => onCreate(name.trim(), members)}>
            Create Group
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== GROUP VIEW =====
function GroupView() {
  const { groupId } = useParams();
  const [group, setGroup] = useState(null);
  const [activeTab, setActiveTab] = useState('expenses');
  const { expenses, loading: expLoading, removeExpense, refresh: refreshExpenses } = useExpenses(groupId);
  const navigate = useNavigate();
  const toast = useToast();
  const [showFab, setShowFab] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showRename, setShowRename] = useState(false);

  useEffect(() => {
    dbOps.getGroup(groupId).then(g => { if (g) setGroup(g); else navigate('/'); });
  }, [groupId, navigate]);

  const updateGroupData = async (updated) => {
    await dbOps.saveGroup(updated);
    setGroup(updated);
  };

  if (!group) return <LoadingScreen />;

  const tabs = ['expenses', 'balances', 'settle', 'analytics'];

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Link to="/" className="btn btn-ghost btn-icon" style={{ fontSize: '1rem' }}>←</Link>
          <h1 className="page-title" style={{ cursor: 'pointer' }} onClick={() => setShowRename(true)}>
            {group.name}
            <span style={{ fontSize: '0.7rem', marginLeft: 8, color: 'var(--text-muted)' }}>✏️</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 46 }}>
          <div className="avatar-stack" style={{ cursor: 'pointer' }} onClick={() => setShowMembers(true)}>
            {group.members.slice(0, 4).map((m, i) => (
              <div key={m.id} className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }} title={m.name}>
                {getInitials(m.name)}
              </div>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowMembers(true)}>
            {group.members.length} members
          </button>
          <button className="btn btn-ghost btn-sm" onClick={async () => {
            const data = await dbOps.exportGroupData(groupId);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `${group.name.replace(/\s+/g, '_')}_export.json`;
            a.click(); URL.revokeObjectURL(url);
            toast('Group exported!', 'success');
          }}>📤 Export</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map(tab => (
          <button key={tab} className={`tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}>
            {tab === 'expenses' ? '📋 Expenses' : tab === 'balances' ? '💰 Balances' : tab === 'settle' ? '🤝 Settle Up' : '📊 Analytics'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'expenses' && <ExpensesTab expenses={expenses} loading={expLoading} group={group} onDelete={(id) => { removeExpense(id); toast('Expense deleted', 'info'); }} />}
      {activeTab === 'balances' && <BalancesTab expenses={expenses} members={group.members} />}
      {activeTab === 'settle' && <SettleTab expenses={expenses} members={group.members} groupId={groupId} group={group} />}
      {activeTab === 'analytics' && <AnalyticsTab expenses={expenses} members={group.members} />}

      {/* FAB */}
      <button className="fab" onClick={() => setShowFab(!showFab)}>
        {showFab ? '✕' : '➕'}
      </button>
      {showFab && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setShowFab(false)} />
          <div className="fab-menu">
            <button className="fab-menu-item" onClick={() => { setShowFab(false); navigate(`/group/${groupId}/scan`); }}>
              📸 Scan Receipt
            </button>
            <button className="fab-menu-item" onClick={() => { setShowFab(false); navigate(`/group/${groupId}/manual`); }}>
              ✏️ Manual Entry
            </button>
          </div>
        </>
      )}

      {/* Member manager modal */}
      {showMembers && <MemberModal group={group} onClose={() => setShowMembers(false)} onUpdate={updateGroupData} />}

      {/* Rename modal */}
      {showRename && <RenameModal group={group} onClose={() => setShowRename(false)} onUpdate={updateGroupData} />}
    </div>
  );
}

function RenameModal({ group, onClose, onUpdate }) {
  const [name, setName] = useState(group.name);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Rename Group</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim()}
            onClick={() => { onUpdate({ ...group, name: name.trim() }); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function MemberModal({ group, onClose, onUpdate }) {
  const [members, setMembers] = useState([...group.members]);
  const [newName, setNewName] = useState('');
  const toast = useToast();

  const addMember = () => {
    if (!newName.trim()) return;
    setMembers([...members, { id: generateId(), name: newName.trim(), color: getMemberColor(members.length) }]);
    setNewName('');
  };

  const removeMember = (id) => {
    setMembers(members.filter(m => m.id !== id));
  };

  const save = () => {
    onUpdate({ ...group, members });
    toast('Members updated', 'success');
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Manage Members</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input" placeholder="Add member" value={newName}
              onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addMember(); }} />
            <button className="btn btn-secondary" onClick={addMember}>Add</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {members.map((m, i) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg-glass)', borderRadius: 'var(--radius-sm)' }}>
                <div className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }}>
                  {getInitials(m.name)}
                </div>
                <span style={{ flex: 1, fontWeight: 500 }}>{m.name}</span>
                <button className="btn btn-ghost btn-icon" style={{ fontSize: '0.7rem' }}
                  onClick={() => removeMember(m.id)}>✕</button>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ===== EXPENSES TAB =====
function ExpensesTab({ expenses, loading, group, onDelete }) {
  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}><div className="spinner spinner-lg" style={{ margin: '0 auto' }} /></div>;

  if (expenses.length === 0) {
    return (
      <div className="empty-state animate-fadeIn">
        <span className="empty-state-icon">🧾</span>
        <h3 className="empty-state-title">No expenses yet</h3>
        <p className="empty-state-text">Scan a receipt or add a manual expense to get started</p>
      </div>
    );
  }

  return (
    <div className="stagger-children" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {expenses.map(exp => {
        const payer = group.members.find(m => m.id === exp.payerId);
        const memberIdx = group.members.findIndex(m => m.id === exp.payerId);
        return (
          <div key={exp.id} className="expense-item">
            <div className="expense-icon" style={{ background: `rgba(124, 58, 237, 0.15)` }}>
              {exp.receiptImageDataUrl ? '🧾' : '✏️'}
            </div>
            <div className="expense-details">
              <div className="expense-name">{exp.description || 'Receipt Expense'}</div>
              <div className="expense-meta">
                Paid by {payer?.name || 'Unknown'} · {formatDate(exp.date || exp.createdAt)}
                {exp.items?.length ? ` · ${exp.items.length} items` : ''}
              </div>
            </div>
            <div className="expense-amount">{formatCurrency(exp.totalPaise || 0)}</div>
            <button className="btn btn-ghost btn-icon" style={{ fontSize: '0.7rem' }}
              onClick={() => { if (confirm('Delete this expense?')) onDelete(exp.id); }}>🗑️</button>
          </div>
        );
      })}
    </div>
  );
}

// ===== BALANCES TAB =====
function BalancesTab({ expenses, members }) {
  const balances = computeNetBalances(expenses, members);
  const maxAbs = Math.max(...Object.values(balances).map(Math.abs), 1);

  return (
    <div className="animate-fadeIn">
      <div className="glass-card-static" style={{ padding: 24 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16 }}>Net Balances</h3>
        {members.map((m, i) => {
          const balance = balances[m.id] || 0;
          const barWidth = Math.max(5, (Math.abs(balance) / maxAbs) * 100);
          return (
            <div key={m.id} className="balance-item">
              <div className="avatar avatar-md" style={{ background: m.color || getMemberColor(i) }}>
                {getInitials(m.name)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 4 }}>{m.name}</div>
                <div className="balance-bar-container">
                  <div className={`balance-bar ${balance >= 0 ? 'positive' : 'negative'}`} style={{ width: `${barWidth}%` }} />
                </div>
              </div>
              <div className={`balance-amount ${balance >= 0 ? 'positive' : 'negative'}`}>
                {balance >= 0 ? 'gets back' : 'owes'} {formatCurrency(Math.abs(balance))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== SETTLE TAB =====
function SettleTab({ expenses, members, groupId, group }) {
  const balances = computeNetBalances(expenses, members);
  const transactions = simplifyDebts(balances);
  const [settlements, setSettlements] = useState([]);
  const toast = useToast();

  useEffect(() => {
    dbOps.getSettlementsByGroup(groupId).then(setSettlements);
  }, [groupId]);

  const toggleSettle = async (txIndex) => {
    // Simple toggle using settlements in IndexedDB
    await dbOps.saveSettlements(groupId, transactions.map((t, i) => ({
      ...t,
      settled: i === txIndex ? !isSettled(t) : isSettled(t),
    })));
    const updated = await dbOps.getSettlementsByGroup(groupId);
    setSettlements(updated);
    toast('Settlement updated', 'success');
  };

  const isSettled = (tx) => {
    return settlements.some(s => s.fromId === tx.from && s.toId === tx.to && s.amountPaise === tx.amountPaise && s.settled);
  };

  const getMember = (id) => members.find(m => m.id === id);

  if (transactions.length === 0) {
    return (
      <div className="empty-state animate-fadeIn">
        <span className="empty-state-icon">✅</span>
        <h3 className="empty-state-title">All settled up!</h3>
        <p className="empty-state-text">No payments needed</p>
      </div>
    );
  }

  return (
    <div className="animate-fadeIn">
      <div style={{ marginBottom: 16 }}>
        <span className="badge badge-cyan">{transactions.length} payment{transactions.length > 1 ? 's' : ''} needed</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {transactions.map((tx, i) => {
          const from = getMember(tx.from);
          const to = getMember(tx.to);
          const settled = isSettled(tx);
          const fromIdx = members.indexOf(from);
          const toIdx = members.indexOf(to);
          const upiLink = generateUPILink({
            payeeName: to?.name || '',
            amount: tx.amountPaise,
            note: `SplitSmart - ${group?.name || 'Settlement'}`,
          });

          return (
            <div key={i} className={`settlement-card ${settled ? 'settled' : ''}`}>
              <div className="avatar avatar-md" style={{ background: from?.color || getMemberColor(fromIdx) }}>
                {getInitials(from?.name)}
              </div>
              <div style={{ textAlign: 'center', flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{from?.name || '?'}</div>
                <div className="settlement-arrow">→ pays →</div>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{to?.name || '?'}</div>
              </div>
              <div className="avatar avatar-md" style={{ background: to?.color || getMemberColor(toIdx) }}>
                {getInitials(to?.name)}
              </div>
              <div style={{ textAlign: 'right', marginLeft: 10 }}>
                <div className="settlement-amount" style={{ color: settled ? 'var(--accent-emerald)' : 'var(--text-primary)' }}>
                  {formatCurrency(tx.amountPaise)}
                </div>
                <div className="settlement-actions" style={{ marginTop: 6 }}>
                  <button className={`btn btn-sm ${settled ? 'btn-ghost' : 'btn-success'}`}
                    onClick={() => toggleSettle(i)}>
                    {settled ? '↩ Undo' : '✓ Settle'}
                  </button>
                  <a href={upiLink} className="btn btn-sm btn-secondary" title="Pay via UPI">
                    💳 UPI
                  </a>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== ANALYTICS TAB =====
function AnalyticsTab({ expenses, members }) {
  const categoryTotals = {};
  const memberTotals = {};
  
  members.forEach(m => { memberTotals[m.id] = { name: m.name, paid: 0, owes: 0 }; });

  for (const exp of expenses) {
    // Category breakdown from items
    if (exp.items) {
      for (const item of exp.items) {
        const cat = item.category || 'Other';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + item.totalPaise;
      }
    }
    // Member spending
    if (exp.payerId && memberTotals[exp.payerId]) {
      memberTotals[exp.payerId].paid += (exp.totalPaise || 0);
    }
    if (exp.splits) {
      for (const [mId, amount] of Object.entries(exp.splits)) {
        if (memberTotals[mId]) memberTotals[mId].owes += amount;
      }
    }
  }

  const totalSpend = Object.values(categoryTotals).reduce((a, b) => a + b, 0);

  if (expenses.length === 0) {
    return (
      <div className="empty-state animate-fadeIn">
        <span className="empty-state-icon">📊</span>
        <h3 className="empty-state-title">No data yet</h3>
        <p className="empty-state-text">Add expenses to see analytics</p>
      </div>
    );
  }

  return (
    <div className="animate-fadeIn" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
      {/* Category breakdown */}
      <div className="glass-card-static" style={{ padding: 24 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16 }}>📊 By Category</h3>
        {Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([cat, amount]) => {
          const pct = totalSpend > 0 ? (amount / totalSpend) * 100 : 0;
          const info = CATEGORIES[cat] || CATEGORIES.Other;
          return (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: '1.2rem', width: 28 }}>{info.emoji}</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{cat}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{formatCurrency(amount)}</span>
                </div>
                <div className="progress-bar" style={{ height: 4 }}>
                  <div className="progress-bar-fill" style={{ width: `${pct}%`, background: 'var(--gradient-primary)' }} />
                </div>
              </div>
            </div>
          );
        })}
        {Object.keys(categoryTotals).length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No categorized items yet</p>
        )}
      </div>

      {/* Member spending */}
      <div className="glass-card-static" style={{ padding: 24 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16 }}>👥 By Member</h3>
        {members.map((m, i) => {
          const data = memberTotals[m.id] || { paid: 0, owes: 0 };
          return (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }}>
                {getInitials(m.name)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{m.name}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Paid: {formatCurrency(data.paid)} · Share: {formatCurrency(data.owes)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary stats */}
      <div className="glass-card-static" style={{ padding: 24 }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: 16 }}>📈 Summary</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <StatCard label="Total Expenses" value={expenses.length} />
          <StatCard label="Total Spent" value={formatCurrency(totalSpend)} />
          <StatCard label="Members" value={members.length} />
          <StatCard label="Avg / Expense" value={expenses.length > 0 ? formatCurrency(Math.round(totalSpend / expenses.length)) : '₹0'} />
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div style={{ padding: 16, background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{value}</div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// ===== RECEIPT SCANNER =====
function ReceiptScanner() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [imageData, setImageData] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const { startCamera, stopCamera, capturePhoto, stream, error: camError, videoRef } = useCamera();
  const [showCamera, setShowCamera] = useState(false);
  const { recognize, progress, status, isProcessing } = useOCR();
  const [rotation, setRotation] = useState(0);

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      toast('Please select an image file', 'warning');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    setImageData(dataUrl);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  };

  const handleCameraCapture = () => {
    const photo = capturePhoto();
    if (photo) {
      setImageData(photo);
      stopCamera();
      setShowCamera(false);
    }
  };

  const handleRotate = async () => {
    if (!imageData) return;
    const newRotation = (rotation + 90) % 360;
    setRotation(newRotation);
    const rotated = await rotateImage(imageData, 90);
    setImageData(rotated);
  };

  const handleProcess = async () => {
    if (!imageData) return;
    try {
      // Preprocess image
      const processed = await preprocessImage(imageData);
      const ocrResult = await recognize(processed);
      
      // Parse the OCR result
      const parsed = parseReceipt(ocrResult);
      
      // Navigate to review page with data
      // Store in sessionStorage since it's temporary
      sessionStorage.setItem('ocrResult', JSON.stringify(ocrResult));
      sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
      sessionStorage.setItem('receiptImage', imageData);
      
      navigate(`/group/${groupId}/review`);
    } catch (err) {
      toast('OCR failed: ' + err.message, 'error');
    }
  };

  const openCamera = async () => {
    const s = await startCamera();
    if (s) setShowCamera(true);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link to={`/group/${groupId}`} className="btn btn-ghost btn-icon">←</Link>
          <h1 className="page-title">Scan Receipt</h1>
        </div>
      </div>

      {!imageData && !showCamera && (
        <div className="animate-fadeIn">
          {/* Dropzone */}
          <div className={`scanner-dropzone ${dragging ? 'dragging' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}>
            <span className="scanner-dropzone-icon">📸</span>
            <div className="scanner-dropzone-text">Drop a receipt image here</div>
            <div className="scanner-dropzone-hint">or click to browse (JPG, PNG)</div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={e => handleFile(e.target.files[0])} />
          </div>

          {/* Camera button */}
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <button className="btn btn-secondary" onClick={openCamera}>
              📷 Use Camera
            </button>
            {camError && (
              <div style={{ marginTop: 12, padding: 12, background: 'rgba(245, 158, 11, 0.1)', borderRadius: 'var(--radius-md)', color: 'var(--accent-amber)', fontSize: '0.85rem' }}>
                ⚠️ {camError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Camera view */}
      {showCamera && (
        <div className="animate-fadeIn">
          <div className="scanner-preview">
            <video ref={videoRef} autoPlay playsInline style={{ width: '100%', display: 'block' }}
              ref={el => { if (el && stream) { el.srcObject = stream; videoRef.current = el; } }} />
            <div className="scanner-preview-actions">
              <button className="btn btn-ghost" onClick={() => { stopCamera(); setShowCamera(false); }}>Cancel</button>
              <button className="btn btn-primary btn-lg" onClick={handleCameraCapture}>📸 Capture</button>
            </div>
          </div>
        </div>
      )}

      {/* Image preview */}
      {imageData && !isProcessing && (
        <div className="animate-fadeIn">
          <div className="scanner-preview">
            <img src={imageData} alt="Receipt preview" />
            <div className="scanner-preview-actions">
              <button className="btn btn-ghost" onClick={() => { setImageData(null); setRotation(0); }}>↩ Retake</button>
              <button className="btn btn-secondary" onClick={handleRotate}>🔄 Rotate</button>
              <button className="btn btn-primary" onClick={handleProcess}>⚡ Process</button>
            </div>
          </div>
        </div>
      )}

      {/* Processing */}
      {isProcessing && (
        <div className="animate-fadeIn" style={{ textAlign: 'center', padding: 40 }}>
          <div className="spinner spinner-lg" style={{ margin: '0 auto 20px' }} />
          <div style={{ fontWeight: 600, marginBottom: 12 }}>{status}</div>
          <div className="progress-bar" style={{ maxWidth: 400, margin: '0 auto' }}>
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 8 }}>{progress}%</div>
        </div>
      )}
    </div>
  );
}

// ===== REVIEW EDITOR =====
function ReviewEditor() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [group, setGroup] = useState(null);
  const [items, setItems] = useState([]);
  const [taxes, setTaxes] = useState([]);
  const [serviceCharge, setServiceCharge] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [total, setTotal] = useState(0);
  const [receiptImage, setReceiptImage] = useState(null);
  const [validation, setValidation] = useState(null);
  const [step, setStep] = useState('review'); // review → assign → split → done
  const [payer, setPayer] = useState('');
  const [description, setDescription] = useState('');
  const [splitMode, setSplitMode] = useState('itemized');
  const [customSplits, setCustomSplits] = useState({});
  const { addExpense } = useExpenses(groupId);

  useEffect(() => {
    dbOps.getGroup(groupId).then(g => {
      if (g) { setGroup(g); if (g.members.length > 0) setPayer(g.members[0].id); }
    });

    // Load parsed data from sessionStorage
    const parsedStr = sessionStorage.getItem('parsedReceipt');
    const imgStr = sessionStorage.getItem('receiptImage');

    if (parsedStr) {
      const parsed = JSON.parse(parsedStr);
      setItems(parsed.items || []);
      setTaxes(parsed.taxes || []);
      setServiceCharge(parsed.serviceCharge || 0);
      setDiscount(parsed.discount || 0);
      setTotal(parsed.total || 0);
    }
    if (imgStr) setReceiptImage(imgStr);
  }, [groupId]);

  // Validate whenever items/taxes change
  useEffect(() => {
    const receipt = { items, taxes, serviceCharge, discount, total };
    setValidation(validateTotal(receipt));
  }, [items, taxes, serviceCharge, discount, total]);

  const updateItem = (idx, field, value) => {
    const updated = [...items];
    if (field === 'totalPaise' || field === 'unitPricePaise') {
      updated[idx][field] = Math.round(parseFloat(value) * 100) || 0;
    } else if (field === 'qty') {
      updated[idx][field] = parseInt(value) || 1;
    } else {
      updated[idx][field] = value;
    }
    // Recalculate
    if (field === 'qty' || field === 'unitPricePaise') {
      updated[idx].totalPaise = updated[idx].qty * updated[idx].unitPricePaise;
    }
    setItems(updated);
  };

  const deleteItem = (idx) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const addItem = () => {
    setItems([...items, {
      id: generateId(),
      name: 'New Item',
      qty: 1,
      unitPricePaise: 0,
      totalPaise: 0,
      category: null,
      assignees: [],
      confidence: 100,
    }]);
  };

  const toggleAssignee = (itemIdx, memberId) => {
    const updated = [...items];
    const item = { ...updated[itemIdx] };
    if (item.assignees.includes(memberId)) {
      item.assignees = item.assignees.filter(a => a !== memberId);
    } else {
      item.assignees = [...item.assignees, memberId];
    }
    updated[itemIdx] = item;
    setItems(updated);
  };

  const assignAllToItem = (itemIdx) => {
    if (!group) return;
    const updated = [...items];
    updated[itemIdx] = { ...updated[itemIdx], assignees: group.members.map(m => m.id) };
    setItems(updated);
  };

  const hasUnassigned = items.some(item => item.assignees.length === 0);

  const handleSave = async () => {
    if (!payer) { toast('Please select who paid', 'warning'); return; }

    let splits = {};
    let totalPaise = total;

    if (splitMode === 'itemized') {
      if (hasUnassigned) { toast('Please assign all items', 'warning'); return; }
      const result = calculateItemizedSplit({ items, taxes, serviceCharge, discount });
      splits = result.splits;
      totalPaise = Object.values(splits).reduce((a, b) => a + b, 0);
    } else if (splitMode === 'equal') {
      const result = calculateEqualSplit(total, group.members.map(m => m.id));
      splits = result.splits;
    } else if (splitMode === 'percentage') {
      const result = calculatePercentageSplit(total, customSplits);
      if (!result.valid) { toast('Percentages must total 100%', 'warning'); return; }
      splits = result.splits;
    } else if (splitMode === 'shares') {
      const result = calculateSharesSplit(total, customSplits);
      splits = result.splits;
    }

    const expense = await addExpense({
      description: description || 'Receipt Expense',
      totalPaise: totalPaise || total,
      payerId: payer,
      date: Date.now(),
      items,
      taxes,
      serviceCharge,
      discount,
      splitMode,
      splits,
      receiptImageDataUrl: receiptImage ? 'stored' : null, // Don't store full image in DB to save space
    });

    // Clean up session
    sessionStorage.removeItem('ocrResult');
    sessionStorage.removeItem('parsedReceipt');
    sessionStorage.removeItem('receiptImage');

    toast('Expense saved!', 'success');
    navigate(`/group/${groupId}`);
  };

  if (!group) return <LoadingScreen />;

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link to={`/group/${groupId}`} className="btn btn-ghost btn-icon">←</Link>
          <h1 className="page-title">
            {step === 'review' ? 'Review Items' : step === 'assign' ? 'Assign Items' : 'Split Summary'}
          </h1>
        </div>
        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, marginLeft: 46 }}>
          {['review', 'assign', 'split'].map((s, i) => (
            <div key={s} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              opacity: step === s ? 1 : 0.4
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: step === s ? 'var(--accent-violet)' : 'var(--bg-glass)',
                fontSize: '0.7rem', fontWeight: 700
              }}>{i + 1}</div>
              <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                {s === 'review' ? 'Review' : s === 'assign' ? 'Assign' : 'Split'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* STEP 1: Review */}
      {step === 'review' && (
        <div className="animate-fadeIn">
          <div className="review-layout">
            {/* Receipt image */}
            {receiptImage && (
              <div className="review-image">
                <img src={receiptImage} alt="Receipt" />
              </div>
            )}
            
            {/* Parsed items table */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>Parsed Items</h3>
                <button className="btn btn-sm btn-secondary" onClick={addItem}>+ Add Item</button>
              </div>
              
              <div className="review-table-container">
                <table className="review-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th style={{ width: 50 }}>Qty</th>
                      <th style={{ width: 90 }}>Price</th>
                      <th style={{ width: 90 }}>Total</th>
                      <th style={{ width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => (
                      <tr key={item.id}>
                        <td>
                          <div className="cell-editable">
                            <input className="input input-sm" value={item.name}
                              onChange={e => updateItem(idx, 'name', e.target.value)}
                              style={{ background: 'transparent', border: 'none', padding: '2px 4px', width: '100%' }} />
                          </div>
                          {item.confidence < 70 && (
                            <span className="low-confidence" data-confidence={`${item.confidence}% confidence`}>
                              ⚠️ Low confidence
                            </span>
                          )}
                          {item.category && (
                            <span className={`category-pill ${CATEGORIES[item.category]?.cssClass || 'category-other'}`} style={{ marginTop: 2 }}>
                              {CATEGORIES[item.category]?.emoji} {item.category}
                            </span>
                          )}
                        </td>
                        <td>
                          <input className="input input-sm input-mono" type="number" min="1" value={item.qty}
                            onChange={e => updateItem(idx, 'qty', e.target.value)}
                            style={{ width: 50, textAlign: 'center' }} />
                        </td>
                        <td>
                          <input className="input input-sm input-mono" type="number" step="0.01"
                            value={(item.unitPricePaise / 100).toFixed(2)}
                            onChange={e => updateItem(idx, 'unitPricePaise', e.target.value)}
                            style={{ width: 85 }} />
                        </td>
                        <td>
                          <span className="input-mono" style={{ fontWeight: 600 }}>
                            ₹{(item.totalPaise / 100).toFixed(2)}
                          </span>
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-icon" style={{ fontSize: '0.7rem' }}
                            onClick={() => deleteItem(idx)}>🗑️</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Tax / charges section */}
              <div style={{ marginTop: 16, padding: 16, background: 'var(--bg-glass)', borderRadius: 'var(--radius-md)' }}>
                {taxes.map((tax, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <input className="input input-sm" value={tax.name} 
                      onChange={e => { const t = [...taxes]; t[idx].name = e.target.value; setTaxes(t); }}
                      style={{ width: 120, background: 'transparent', border: 'none' }} />
                    <span className="input-mono" style={{ color: 'var(--text-secondary)' }}>
                      ₹{(tax.amountPaise / 100).toFixed(2)}
                    </span>
                  </div>
                ))}
                {serviceCharge > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>Service Charge</span>
                    <span className="input-mono">₹{(serviceCharge / 100).toFixed(2)}</span>
                  </div>
                )}
                {discount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--accent-emerald)' }}>Discount</span>
                    <span className="input-mono" style={{ color: 'var(--accent-emerald)' }}>-₹{(discount / 100).toFixed(2)}</span>
                  </div>
                )}
                <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                  <span>Total</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>₹</span>
                    <input className="input input-sm input-mono" type="number" step="0.01"
                      value={(total / 100).toFixed(2)}
                      onChange={e => setTotal(Math.round(parseFloat(e.target.value) * 100) || 0)}
                      style={{ width: 100, fontWeight: 700 }} />
                  </div>
                </div>
              </div>

              {/* Validation */}
              {validation && (
                <div className={`validator-bar ${validation.valid ? 'valid' : 'invalid'}`} style={{ marginTop: 12 }}>
                  {validation.valid ? '✅' : '⚠️'} {validation.message}
                </div>
              )}

              {/* Description and Payer */}
              <div style={{ marginTop: 20, display: 'grid', gap: 12 }}>
                <div>
                  <label className="label">Description</label>
                  <input className="input" placeholder="e.g., Night canteen order"
                    value={description} onChange={e => setDescription(e.target.value)} />
                </div>
                <div>
                  <label className="label">Paid by</label>
                  <select className="input" value={payer} onChange={e => setPayer(e.target.value)}>
                    {group.members.map(m => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <Link to={`/group/${groupId}`} className="btn btn-ghost">Cancel</Link>
                <button className="btn btn-primary" onClick={() => setStep('assign')} disabled={items.length === 0}>
                  Next: Assign Items →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2: Assign */}
      {step === 'assign' && (
        <div className="animate-fadeIn">
          <div style={{ marginBottom: 16 }}>
            <div className="split-mode-selector" style={{ maxWidth: 500 }}>
              {['itemized', 'equal', 'percentage', 'shares'].map(mode => (
                <button key={mode} className={`split-mode-btn ${splitMode === mode ? 'active' : ''}`}
                  onClick={() => setSplitMode(mode)}>
                  {mode === 'itemized' ? '🎯 Itemized' : mode === 'equal' ? '⚖️ Equal' : mode === 'percentage' ? '📊 Percentage' : '🔢 Shares'}
                </button>
              ))}
            </div>
          </div>

          {splitMode === 'itemized' && (
            <>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 16 }}>
                Tap avatars to assign each item. Shared items are split evenly among assignees.
              </p>
              {items.map((item, idx) => (
                <div key={item.id} className={`assignment-item ${item.assignees.length === 0 ? 'unassigned' : ''}`}>
                  <div className="assignment-item-info">
                    <div className="assignment-item-name">{item.name}</div>
                    <div className="assignment-item-price">
                      {item.qty > 1 && `${item.qty} × ₹${(item.unitPricePaise / 100).toFixed(2)} = `}
                      ₹{(item.totalPaise / 100).toFixed(2)}
                      {item.assignees.length > 1 && (
                        <span style={{ color: 'var(--accent-cyan)', marginLeft: 8 }}>
                          (₹{((item.totalPaise / item.assignees.length) / 100).toFixed(2)} each)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="assignment-avatars">
                    {group.members.map((m, i) => (
                      <div key={m.id}
                        className={`avatar avatar-md avatar-selectable ${item.assignees.includes(m.id) ? 'selected' : ''}`}
                        style={{ background: m.color || getMemberColor(i) }}
                        onClick={() => toggleAssignee(idx, m.id)}
                        title={m.name}>
                        {getInitials(m.name)}
                      </div>
                    ))}
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: '0.7rem' }}
                      onClick={() => assignAllToItem(idx)} title="Assign to all">All</button>
                  </div>
                </div>
              ))}
              {hasUnassigned && (
                <div className="validator-bar invalid" style={{ marginTop: 12 }}>
                  ⚠️ Some items are not assigned. Please assign all items before saving.
                </div>
              )}
            </>
          )}

          {splitMode === 'equal' && (
            <div className="glass-card-static" style={{ padding: 24 }}>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
                Total ₹{(total / 100).toFixed(2)} will be split equally among all {group.members.length} members.
              </p>
              {group.members.map((m, i) => {
                const share = calculateEqualSplit(total, group.members.map(x => x.id)).splits[m.id] || 0;
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-glass)' }}>
                    <div className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }}>{getInitials(m.name)}</div>
                    <span style={{ flex: 1, fontWeight: 500 }}>{m.name}</span>
                    <span className="input-mono" style={{ fontWeight: 700 }}>{formatCurrency(share)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {splitMode === 'percentage' && (
            <div className="glass-card-static" style={{ padding: 24 }}>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>Enter percentage for each member (must total 100%).</p>
              {group.members.map((m, i) => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }}>{getInitials(m.name)}</div>
                  <span style={{ flex: 1, fontWeight: 500 }}>{m.name}</span>
                  <input className="input input-sm input-mono" type="number" step="0.1" min="0" max="100"
                    value={customSplits[m.id] || ''} placeholder="0"
                    onChange={e => setCustomSplits({ ...customSplits, [m.id]: parseFloat(e.target.value) || 0 })}
                    style={{ width: 80, textAlign: 'right' }} />
                  <span style={{ color: 'var(--text-muted)' }}>%</span>
                </div>
              ))}
              {(() => {
                const totalPct = Object.values(customSplits).reduce((a, b) => a + b, 0);
                return (
                  <div className={`validator-bar ${Math.abs(totalPct - 100) < 0.01 ? 'valid' : 'invalid'}`} style={{ marginTop: 8 }}>
                    Total: {totalPct.toFixed(1)}% {Math.abs(totalPct - 100) < 0.01 ? '✓' : `(need 100%)`}
                  </div>
                );
              })()}
            </div>
          )}

          {splitMode === 'shares' && (
            <div className="glass-card-static" style={{ padding: 24 }}>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>Enter share count for each member (e.g., 2:1:1).</p>
              {group.members.map((m, i) => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }}>{getInitials(m.name)}</div>
                  <span style={{ flex: 1, fontWeight: 500 }}>{m.name}</span>
                  <input className="input input-sm input-mono" type="number" min="0" step="1"
                    value={customSplits[m.id] || ''} placeholder="1"
                    onChange={e => setCustomSplits({ ...customSplits, [m.id]: parseInt(e.target.value) || 0 })}
                    style={{ width: 60, textAlign: 'center' }} />
                  <span style={{ color: 'var(--text-muted)' }}>shares</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setStep('review')}>← Back</button>
            <button className="btn btn-primary" onClick={() => setStep('split')}>
              Next: View Split →
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: Split Summary */}
      {step === 'split' && (
        <div className="animate-fadeIn">
          {(() => {
            let splits = {};
            let breakdown = null;

            if (splitMode === 'itemized') {
              const result = calculateItemizedSplit({ items, taxes, serviceCharge, discount });
              splits = result.splits;
              breakdown = result.breakdown;
            } else if (splitMode === 'equal') {
              splits = calculateEqualSplit(total, group.members.map(m => m.id)).splits;
            } else if (splitMode === 'percentage') {
              splits = calculatePercentageSplit(total, customSplits).splits;
            } else if (splitMode === 'shares') {
              splits = calculateSharesSplit(total, customSplits).splits;
            }

            const totalCheck = Object.values(splits).reduce((a, b) => a + b, 0);
            const payerMember = group.members.find(m => m.id === payer);

            return (
              <>
                <div style={{ marginBottom: 20 }}>
                  <div className="glass-card-static" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span>💳</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>Paid by {payerMember?.name || '?'}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{description || 'Receipt Expense'}</div>
                    </div>
                    <div style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '1.2rem' }}>
                      {formatCurrency(total)}
                    </div>
                  </div>
                </div>

                {group.members.map((m, i) => {
                  const share = splits[m.id] || 0;
                  const bd = breakdown?.[m.id];
                  if (share === 0 && !bd) return null;

                  return (
                    <div key={m.id} className="split-card">
                      <div className="split-card-header">
                        <div className="avatar avatar-md" style={{ background: m.color || getMemberColor(i) }}>
                          {getInitials(m.name)}
                        </div>
                        <span className="split-card-name">{m.name}</span>
                        <span className="split-card-total">{formatCurrency(share)}</span>
                      </div>
                      {bd && (
                        <div style={{ marginLeft: 46 }}>
                          <div className="split-line">
                            <span>Items subtotal</span>
                            <span className="split-line-amount">{formatCurrency(bd.items)}</span>
                          </div>
                          {bd.tax > 0 && (
                            <div className="split-line">
                              <span>+ Tax (proportional)</span>
                              <span className="split-line-amount">{formatCurrency(bd.tax)}</span>
                            </div>
                          )}
                          {bd.serviceCharge > 0 && (
                            <div className="split-line">
                              <span>+ Service charge</span>
                              <span className="split-line-amount">{formatCurrency(bd.serviceCharge)}</span>
                            </div>
                          )}
                          {bd.discount > 0 && (
                            <div className="split-line">
                              <span style={{ color: 'var(--accent-emerald)' }}>− Discount</span>
                              <span className="split-line-amount" style={{ color: 'var(--accent-emerald)' }}>-{formatCurrency(bd.discount)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div className={`validator-bar ${Math.abs(totalCheck - total) <= 1 ? 'valid' : 'invalid'}`} style={{ marginTop: 12 }}>
                  {Math.abs(totalCheck - total) <= 1
                    ? `✅ All shares sum to ${formatCurrency(totalCheck)}`
                    : `⚠️ Shares sum to ${formatCurrency(totalCheck)}, expected ${formatCurrency(total)}`}
                </div>

                <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" onClick={() => setStep('assign')}>← Back</button>
                  <button className="btn btn-success btn-lg" onClick={handleSave}>
                    ✓ Save Expense
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ===== MANUAL EXPENSE =====
function ManualExpense() {
  const { groupId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [group, setGroup] = useState(null);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [payer, setPayer] = useState('');
  const [participants, setParticipants] = useState([]);
  const [splitMode, setSplitMode] = useState('equal');
  const { addExpense } = useExpenses(groupId);

  useEffect(() => {
    dbOps.getGroup(groupId).then(g => {
      if (g) {
        setGroup(g);
        setPayer(g.members[0]?.id || '');
        setParticipants(g.members.map(m => m.id));
      }
    });
  }, [groupId]);

  const handleSave = async () => {
    if (!description.trim()) { toast('Enter a description', 'warning'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Enter a valid amount', 'warning'); return; }
    if (!payer) { toast('Select who paid', 'warning'); return; }
    if (participants.length === 0) { toast('Select at least one participant', 'warning'); return; }

    const totalPaise = Math.round(parseFloat(amount) * 100);
    const splits = calculateEqualSplit(totalPaise, participants).splits;

    await addExpense({
      description: description.trim(),
      totalPaise,
      payerId: payer,
      date: Date.now(),
      items: [],
      taxes: [],
      serviceCharge: 0,
      discount: 0,
      splitMode: 'equal',
      splits,
      receiptImageDataUrl: null,
    });

    toast('Expense added!', 'success');
    navigate(`/group/${groupId}`);
  };

  if (!group) return <LoadingScreen />;

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link to={`/group/${groupId}`} className="btn btn-ghost btn-icon">←</Link>
          <h1 className="page-title">Manual Expense</h1>
        </div>
      </div>

      <div className="glass-card-static animate-fadeIn" style={{ padding: 24, maxWidth: 500 }}>
        <div className="modal-body">
          <div>
            <label className="label">Description</label>
            <input className="input" placeholder="e.g., Wi-Fi recharge" value={description}
              onChange={e => setDescription(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Amount (₹)</label>
            <input className="input input-mono" type="number" step="0.01" placeholder="0.00"
              value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="label">Paid by</label>
            <select className="input" value={payer} onChange={e => setPayer(e.target.value)}>
              {group.members.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Participants</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {group.members.map((m, i) => (
                <div key={m.id}
                  className={`avatar avatar-md avatar-selectable ${participants.includes(m.id) ? 'selected' : ''}`}
                  style={{ background: m.color || getMemberColor(i) }}
                  onClick={() => {
                    setParticipants(participants.includes(m.id)
                      ? participants.filter(p => p !== m.id)
                      : [...participants, m.id]);
                  }}
                  title={m.name}>
                  {getInitials(m.name)}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <Link to={`/group/${groupId}`} className="btn btn-ghost">Cancel</Link>
          <button className="btn btn-primary" onClick={handleSave}>💾 Save Expense</button>
        </div>
      </div>
    </div>
  );
}

// ===== LOADING SCREEN =====
function LoadingScreen() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="spinner spinner-lg" style={{ margin: '0 auto 16px' }} />
        <div style={{ color: 'var(--text-secondary)' }}>Loading...</div>
      </div>
    </div>
  );
}
