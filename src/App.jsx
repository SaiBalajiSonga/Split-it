import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { HashRouter, Routes, Route, useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { ToastProvider, useToast, useGroups, useExpenses, useOCR, useCamera } from './hooks/useAppHooks';
import { parseReceipt, validateTotal, cleanItemName } from './logic/receiptParser';
import { calculateItemizedSplit, calculateEqualSplit, calculatePercentageSplit, calculateSharesSplit, computeNetBalances } from './logic/splitEngine';
import { simplifyDebts } from './logic/debtSimplifier';
import { formatCurrency, formatDate, formatRelativeTime, getInitials, getMemberColor, CATEGORIES, generateUPILink } from './utils/formatters';
import { preprocessImage, rotateImage, readFileAsDataUrl } from './utils/imagePreprocess';
import { generateId } from './db/database';
import * as dbOps from './db/database';
import './index.css';

// ===== MAIN APP =====
export default function App() {
  const [showCreateModal, setShowCreateModal] = useState(false);

  return (
    <HashRouter>
      <ToastProvider>
        {/* Floating Browser Canvas Window (Matching ChronoTask / Reference) */}
        <div className="browser-canvas-frame">
          <Navbar onCreateGroup={() => setShowCreateModal(true)} />
          <main className="canvas-content">
            <Routes>
              <Route path="/" element={<Dashboard showCreate={showCreateModal} setShowCreate={setShowCreateModal} />} />
              <Route path="/group/:groupId" element={<GroupView />} />
              <Route path="/group/:groupId/scan" element={<ReceiptScanner />} />
              <Route path="/group/:groupId/manual" element={<ManualExpense />} />
              <Route path="/group/:groupId/review" element={<ReviewEditor />} />
              {/* Fallback to Dashboard to prevent blank screen */}
              <Route path="*" element={<Dashboard showCreate={showCreateModal} setShowCreate={setShowCreateModal} />} />
            </Routes>
          </main>
        </div>
      </ToastProvider>
    </HashRouter>
  );
}

// ===== USER PROFILE & UPI SETTINGS MODAL =====
function ProfileModal({ onClose }) {
  const [name, setName] = useState(localStorage.getItem('splitsmart_my_name') || '');
  const [upi, setUpi] = useState(localStorage.getItem('splitsmart_my_upi') || '');
  const toast = useToast();

  const handleSave = () => {
    localStorage.setItem('splitsmart_my_name', name.trim());
    localStorage.setItem('splitsmart_my_upi', upi.trim());
    window.dispatchEvent(new Event('splitsmart_profile_updated'));
    toast('Profile and personal UPI ID saved!', 'success');
    onClose();
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal-content animate-scaleIn" onClick={e => e.stopPropagation()} style={{ maxWidth: 440, margin: 'auto' }}>
        <div className="modal-header">
          <h2 className="modal-title" style={{ fontSize: '1.2rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>👤</span>
            <span>My Profile & UPI</span>
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', margin: 0, lineHeight: 1.5 }}>
            Set your personal name and UPI ID. Whenever anyone settles a bill with you in any group, their QR code and UPI link will pay directly to this ID!
          </p>
          <div>
            <label className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 6, display: 'block' }}>Your Name</label>
            <input
              className="input"
              placeholder="e.g. Sai Balaji"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label" style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 6, display: 'block' }}>Your Personal UPI ID</label>
            <input
              className="input input-mono"
              placeholder="e.g. saibalaji@okhdfcbank"
              value={upi}
              onChange={e => setUpi(e.target.value)}
            />
            <span style={{ fontSize: '0.74rem', color: 'var(--ink-muted)', marginTop: 4, display: 'block' }}>
              Accepts any VPA: GPay, PhonePe, Paytm, BHIM, Cred, etc.
            </span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Settings</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ===== MINIMAL CANVAS NAVBAR (Matching Reference) =====
function Navbar({ onCreateGroup }) {
  const navigate = useNavigate();
  const [showProfile, setShowProfile] = useState(false);
  const [myName, setMyName] = useState(localStorage.getItem('splitsmart_my_name') || '');

  useEffect(() => {
    const handleUpdate = () => {
      setMyName(localStorage.getItem('splitsmart_my_name') || '');
    };
    window.addEventListener('splitsmart_profile_updated', handleUpdate);
    window.addEventListener('storage', handleUpdate);
    return () => {
      window.removeEventListener('splitsmart_profile_updated', handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, []);

  const scrollToGroups = (e) => {
    e.preventDefault();
    navigate('/');
    setTimeout(() => {
      const el = document.getElementById('groups-anchor');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    }, 60);
  };

  return (
    <nav className="canvas-navbar">
      <Link to="/" className="brand-wrap">
        <div className="brand-dice-icon">
          <div className="brand-dice-dot dot-blue" />
          <div className="brand-dice-dot" />
          <div className="brand-dice-dot" />
          <div className="brand-dice-dot" />
        </div>
        <span>SplitSmart</span>
      </Link>

      <div className="nav-links-row">
        <Link to="/" className="nav-text-link">Dashboard</Link>
        <button
          className="nav-text-link nav-btn-link"
          onClick={scrollToGroups}
        >
          Your Groups
        </button>
        <button
          className="nav-text-link nav-btn-link"
          onClick={() => navigate('/group/jugadu-cafe/scan')}
        >
          Scan Receipt
        </button>
      </div>

      <div className="nav-actions-row">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowProfile(true)}
          title="Set your name and default UPI ID"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, border: '1px solid var(--border-card)' }}
        >
          👤 {myName ? `${myName} (You)` : 'My Profile & UPI'}
        </button>
        <ExportImportButton />
        <button className="btn btn-secondary btn-sm" onClick={onCreateGroup}>
          + New Group
        </button>
      </div>
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
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
      <button className="btn btn-ghost btn-sm" onClick={() => setShowMenu(!showMenu)} title="Import / Export Data">
        📥 Import
      </button>
      {showMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setShowMenu(false)} />
          <div style={{
            position: 'absolute', right: 0, top: '100%', marginTop: 8,
            background: '#ffffff', border: '1px solid #e2e8f0',
            borderRadius: 14, padding: 8, minWidth: 190, zIndex: 100,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.12)'
          }}>
            <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.85rem' }}
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

// ===== DASHBOARD WITH FLOATING TACTILE CARDS HERO =====
function Dashboard({ showCreate: externalShowCreate, setShowCreate: externalSetShowCreate }) {
  const { groups, loading, createGroup, deleteGroup } = useGroups();
  const [internalShowCreate, setInternalShowCreate] = useState(false);
  const [showAddFriend, setShowAddFriend] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const showCreate = externalShowCreate !== undefined ? externalShowCreate : internalShowCreate;
  const setShowCreate = externalSetShowCreate || setInternalShowCreate;

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '100px 20px' }}>
        <div className="spinner" style={{ marginBottom: 16 }} />
        <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--ink-muted)' }}>Loading SplitSmart...</div>
      </div>
    );
  }

  const activeGroup = groups && groups.length > 0 ? groups[0] : null;

  // Collect unique members across groups
  const memberMap = new Map();
  groups.forEach(g => {
    (g.members || []).forEach(m => {
      if (!memberMap.has(m.name.toLowerCase())) {
        memberMap.set(m.name.toLowerCase(), m);
      }
    });
  });
  const allConnectedMembers = Array.from(memberMap.values());

  const fallbackMembers = [
    { name: 'Danny C.', color: '#FF9AA2' },
    { name: 'Jerry P.', color: '#FFB7B2' },
    { name: 'Richard A.', color: '#FFDAC1' },
    { name: 'Eden F.', color: '#E2F0CB' },
    { name: 'John D.', color: '#B5EAD7' },
    { name: 'Jabir H.', color: '#C7CEEA' },
  ];

  const friendsList = allConnectedMembers.length > 0 ? allConnectedMembers : fallbackMembers;

  const handleScanReceipt = () => {
    const targetGroupId = activeGroup?.id || 'jugadu-cafe';
    navigate(`/group/${targetGroupId}/scan`);
  };

  return (
    <div>
      {/* Hero Showcase (Faithful to Reference ChronoTask) */}
      <section className="hero-showcase">
        {/* Floating Accessory 1: Yellow Sticky Note (Top-Left) */}
        <div className="hero-accessory-card acc-sticky-note">
          <div className="sticky-pin" />
          <div className="sticky-note-text">
            Dinner with Gang: 9 items detected, ₹3,275 verified. Settle up seamlessly.
          </div>
          <div className="sticky-checkbox-card">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>

        {/* Floating Accessory 2: Folder Tab Reminders (Top-Right) */}
        <div className="hero-accessory-card acc-reminder-card">
          <div className="folder-tab-badge">
            <span>⏱️</span>
            <span>Reminders</span>
          </div>
          <div className="reminder-title">Today's Settle Up</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', marginBottom: 8 }}>
            Kabir owes Riya ₹210.00
          </div>
          <div className="reminder-time-pill">
            <span>🕒</span>
            <span>13:00 - 13:45</span>
          </div>
        </div>

        {/* Center Floating 3D Cube */}
        <div className="hero-center-cube">
          <div className="hero-cube-dots">
            <div className="cube-dot blue" />
            <div className="cube-dot" />
            <div className="cube-dot" />
            <div className="cube-dot" />
          </div>
        </div>

        {/* Hero Headline & Subtitle */}
        <h1 className="hero-main-h1">
          Split, plan, and track <br />
          <span className="hero-h1-subline">all in one place</span>
        </h1>

        <p className="hero-main-sub">
          Efficiently manage shared expenses, scan receipts with OCR, and settle debts instantly.
        </p>

        {/* Blue Pill CTA Button */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="hero-cta-btn" onClick={handleScanReceipt}>
            <span>📷</span>
            <span>Scan Receipt Free</span>
          </button>
          <button className="btn btn-secondary" style={{ padding: '13px 24px' }} onClick={() => setShowCreate(true)}>
            + Create Group
          </button>
        </div>

        {/* Floating Accessory 3: Active Splits Card (Bottom-Left) */}
        <div className="hero-accessory-card acc-tasks-card">
          <div className="tasks-header">Today's Splits</div>
          <div className="task-row">
            <div className="task-label-row">
              <span>🍗 Night Canteen</span>
              <span>60%</span>
            </div>
            <div className="task-bar-track">
              <div className="task-bar-fill" style={{ width: '60%' }} />
            </div>
          </div>
          <div className="task-row" style={{ marginBottom: 0 }}>
            <div className="task-label-row">
              <span>☕ CCD Cafe</span>
              <span>100%</span>
            </div>
            <div className="task-bar-track">
              <div className="task-bar-fill" style={{ width: '100%', background: '#10b981' }} />
            </div>
          </div>
        </div>

        {/* Floating Accessory 4: Instant UPI Integrations (Bottom-Right) */}
        <div className="hero-accessory-card acc-integrations-card">
          <div className="integrations-header">Instant UPI Settle</div>
          <div className="integration-tiles">
            <div className="integration-tile" title="Google Pay">🇬</div>
            <div className="integration-tile" title="PhonePe">🇵</div>
            <div className="integration-tile" title="Paytm">🔷</div>
            <div className="integration-tile" title="BHIM UPI">⚡</div>
          </div>
        </div>
      </section>

      {/* Connected Friends Section */}
      <section className="app-section" style={{ marginBottom: 32 }}>
        <div className="section-head">
          <div>
            <h2 className="section-head-title">Connected Friends</h2>
            <div style={{ fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
              {friendsList.length} people connected across groups
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAddFriend(true)}>
            + Add Friend
          </button>
        </div>

        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6 }}>
          {friendsList.map((f, idx) => (
            <div
              key={f.id || idx}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: '#ffffff', border: '1px solid #e5e7eb',
                borderRadius: 999, padding: '6px 14px 6px 8px',
                boxShadow: '0 2px 6px rgba(0,0,0,0.03)', flexShrink: 0, cursor: 'pointer'
              }}
              onClick={() => {
                if (activeGroup) navigate(`/group/${activeGroup.id}`);
              }}
            >
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: f.color || getMemberColor(idx),
                color: '#ffffff', fontWeight: 700, fontSize: '0.75rem',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                {getInitials(f.name)}
              </div>
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-primary)' }}>
                {f.name}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Real Expense Groups Section (100% Logic from Project) */}
      <section className="app-section" id="groups-anchor">
        <div className="section-head">
          <div>
            <h2 className="section-head-title">Your Expense Groups</h2>
            <div style={{ fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
              {groups.length} {groups.length === 1 ? 'group' : 'groups'} active
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            + Create Group
          </button>
        </div>

        {groups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px', background: '#ffffff', borderRadius: 18, border: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>👥</div>
            <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--ink-primary)', marginBottom: 4 }}>No groups yet</h3>
            <p style={{ fontSize: '0.88rem', color: 'var(--ink-muted)', marginBottom: 20 }}>Create your first group to start scanning receipts and splitting bills.</p>
            <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
              + Create Group
            </button>
          </div>
        ) : (
          <div className="groups-bento-grid">
            {groups.map(group => (
              <RealGroupCard
                key={group.id}
                group={group}
                onClick={() => navigate(`/group/${group.id}`)}
                onDelete={() => {
                  deleteGroup(group.id);
                  toast('Group deleted', 'info');
                }}
                onScan={() => navigate(`/group/${group.id}/scan`)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Modals */}
      {showCreate && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onCreate={async (name, members) => {
            const group = await createGroup(name, members);
            toast('Group created with ' + members.length + ' members!', 'success');
            setShowCreate(false);
            navigate(`/group/${group.id}`);
          }}
        />
      )}

      {showAddFriend && (
        <QuickAddFriendModal
          group={activeGroup}
          onClose={() => setShowAddFriend(false)}
          onAdded={() => {
            toast('Friend added successfully!', 'success');
            setShowAddFriend(false);
          }}
        />
      )}
    </div>
  );
}

// ===== REAL GROUP CARD (Loads Real Expenses & Balances) =====
function RealGroupCard({ group, onClick, onDelete, onScan }) {
  const [expenseCount, setExpenseCount] = useState(0);
  const [totalSpent, setTotalSpent] = useState(0);

  useEffect(() => {
    dbOps.getExpensesByGroup(group.id).then(expenses => {
      setExpenseCount(expenses.length);
      const sum = expenses.reduce((acc, e) => acc + (e.totalPaise || 0), 0);
      setTotalSpent(sum);
    });
  }, [group.id]);

  return (
    <div className="real-group-card" onClick={onClick}>
      <div className="group-card-head">
        <div>
          <div className="group-card-title">{group.name}</div>
          <div className="group-card-subtitle">
            {group.members?.length || 0} members · Updated {formatRelativeTime(group.updatedAt)}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-icon"
          style={{ fontSize: '0.85rem' }}
          onClick={e => {
            e.stopPropagation();
            if (confirm('Delete this group?')) onDelete();
          }}
          title="Delete Group"
        >
          🗑️
        </button>
      </div>

      <div className="group-members-strip">
        {(group.members || []).slice(0, 5).map((m, i) => (
          <div
            key={m.id || i}
            className="group-member-avatar"
            style={{ background: m.color || getMemberColor(i) }}
            title={m.name}
          >
            {getInitials(m.name)}
          </div>
        ))}
        {(group.members?.length || 0) > 5 && (
          <div className="group-member-avatar" style={{ background: '#f1f5f9', color: '#4b5563', fontSize: '0.65rem' }}>
            +{group.members.length - 5}
          </div>
        )}
      </div>

      <div className="group-card-bottom">
        <div className="group-stat-text">
          <strong>{formatCurrency(totalSpent)}</strong> tracked ({expenseCount} bills)
        </div>
        <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
          <button className="btn btn-secondary btn-sm" onClick={onScan}>
            📷 Scan
          </button>
          <button className="btn btn-primary btn-sm" onClick={onClick}>
            Open →
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== QUICK ADD FRIEND MODAL =====
function QuickAddFriendModal({ group, onClose, onAdded }) {
  const [friendName, setFriendName] = useState('');
  const toast = useToast();

  const handleAdd = async (e) => {
    e?.preventDefault();
    if (!friendName.trim()) return;
    if (!group) {
      toast('Please create a group first', 'warning');
      return;
    }
    const newMember = {
      id: generateId(),
      name: friendName.trim(),
      color: getMemberColor(group.members?.length || 0),
    };
    const updated = {
      ...group,
      members: [...(group.members || []), newMember],
    };
    await dbOps.saveGroup(updated);
    onAdded();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 800 }}>Add New Friend</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleAdd}>
          <p style={{ fontSize: '0.88rem', color: 'var(--ink-secondary)', marginBottom: 16 }}>
            Add a friend or roommate to split bills with:
          </p>
          <input
            className="input"
            placeholder="Friend's name (e.g., Sophia Patel)"
            value={friendName}
            onChange={e => setFriendName(e.target.value)}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} style={{ flex: 1 }}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" style={{ flex: 1 }}>
              Add Friend
            </button>
          </div>
        </form>
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

  const loadSampleWing = () => {
    setName('Wing 4 Canteen Gang');
    setMembers([
      { id: generateId(), name: 'Aarav Sharma', color: getMemberColor(0), upi: 'aarav@okhdfcbank' },
      { id: generateId(), name: 'Priya Nair', color: getMemberColor(1), upi: 'priya@oksbi' },
      { id: generateId(), name: 'Rohan Verma', color: getMemberColor(2), upi: 'rohan@paytm' },
      { id: generateId(), name: 'Sneha Patel', color: getMemberColor(3), upi: 'sneha@okicici' },
    ]);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Create Group</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={loadSampleWing}
              style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)' }}>
              ✨ Fill Sample Hostel Wing
            </button>
          </div>
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
  const { expenses, loading: expLoading, removeExpense } = useExpenses(groupId);
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Link to="/" className="btn btn-ghost btn-icon" style={{ fontSize: '1.1rem' }}>←</Link>
          <h1 className="page-title" style={{ cursor: 'pointer' }} onClick={() => setShowRename(true)}>
            {group.name}
            <span style={{ fontSize: '0.8rem', marginLeft: 8, color: 'var(--ink-muted)' }}>✏️</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingLeft: 4 }}>
          <div className="avatar-stack" style={{ cursor: 'pointer' }} onClick={() => setShowMembers(true)}>
            {group.members.slice(0, 5).map((m, i) => (
              <div key={m.id} className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }} title={m.name}>
                {getInitials(m.name)}
              </div>
            ))}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowMembers(true)}>
            👥 {group.members.length} members
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
            <button className="fab-menu-item" onClick={() => { setShowFab(false); navigate(`/group/${groupId}/scan?tab=text`); }}>
              📋 Paste Bill Text (No Scan)
            </button>
            <button className="fab-menu-item" onClick={() => { setShowFab(false); navigate(`/group/${groupId}/scan`); }}>
              📸 Scan Photo / Upload
            </button>
            <button className="fab-menu-item" onClick={() => { setShowFab(false); navigate(`/group/${groupId}/manual`); }}>
              ✏️ Manual Item Entry
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
  const [newUpi, setNewUpi] = useState('');
  const [editingUpiId, setEditingUpiId] = useState(null);
  const [tempUpi, setTempUpi] = useState('');
  const toast = useToast();

  const myName = localStorage.getItem('splitsmart_my_name') || '';
  const myUpi = localStorage.getItem('splitsmart_my_upi') || '';

  const addMember = () => {
    if (!newName.trim()) return;
    const trimmed = newName.trim();
    const isMe = myName && trimmed.toLowerCase() === myName.toLowerCase();
    const upiVal = newUpi.trim() || (isMe ? myUpi : '');
    setMembers([...members, { 
      id: generateId(), 
      name: trimmed, 
      upi: upiVal, 
      color: getMemberColor(members.length) 
    }]);
    setNewName('');
    setNewUpi('');
  };

  const removeMember = (id) => {
    setMembers(members.filter(m => m.id !== id));
  };

  const setAsMe = (member) => {
    localStorage.setItem('splitsmart_my_name', member.name);
    if (member.upi) {
      localStorage.setItem('splitsmart_my_upi', member.upi);
    }
    window.dispatchEvent(new Event('splitsmart_profile_updated'));
    toast(`Tagged "${member.name}" as You!`, 'success');
  };

  const saveMemberUpi = (id) => {
    setMembers(members.map(m => m.id === id ? { ...m, upi: tempUpi.trim() } : m));
    const member = members.find(m => m.id === id);
    if (member && myName && member.name.toLowerCase() === myName.toLowerCase()) {
      localStorage.setItem('splitsmart_my_upi', tempUpi.trim());
      window.dispatchEvent(new Event('splitsmart_profile_updated'));
    }
    setEditingUpiId(null);
    toast('UPI ID updated', 'success');
  };

  const save = () => {
    onUpdate({ ...group, members });
    toast('Members updated', 'success');
    onClose();
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal-content animate-scaleIn" onClick={e => e.stopPropagation()} style={{ maxWidth: 500, margin: 'auto' }}>
        <div className="modal-header">
          <h2 className="modal-title" style={{ fontSize: '1.2rem' }}>👥 Manage Members & UPI</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Add member row */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-subtle)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--ink-secondary)' }}>Add Friend to Group</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                placeholder="Name (e.g. Anjali)"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addMember(); }}
                style={{ flex: 1 }}
              />
              <input
                className="input input-mono"
                placeholder="UPI ID (optional)"
                value={newUpi}
                onChange={e => setNewUpi(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addMember(); }}
                style={{ flex: 1 }}
              />
              <button className="btn btn-secondary btn-sm" onClick={addMember}>+ Add</button>
            </div>
          </div>

          {/* Members list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflowY: 'auto' }}>
            {members.map((m, i) => {
              const isMe = (myName && m.name.toLowerCase() === myName.toLowerCase()) || m.isMe;
              const isEditingThisUpi = editingUpiId === m.id;

              return (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: isMe ? 'var(--accent-blue-light)' : 'var(--bg-canvas)', border: isMe ? '1px solid #bfdbfe' : '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="avatar avatar-sm" style={{ background: m.color || getMemberColor(i) }}>
                      {getInitials(m.name)}
                    </div>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 600, color: 'var(--ink-primary)' }}>{m.name}</span>
                      {isMe ? (
                        <span className="badge badge-cyan" style={{ fontSize: '0.68rem' }}>⭐ You</span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          style={{ border: '1px solid var(--border-subtle)', fontSize: '0.68rem', padding: '2px 6px' }}
                          onClick={() => setAsMe(m)}
                          title="Tag this member as yourself"
                        >
                          ⭐ Set as Me
                        </button>
                      )}
                    </div>

                    <button
                      className="btn btn-ghost btn-icon"
                      style={{ fontSize: '0.75rem', width: 28, height: 28 }}
                      onClick={() => removeMember(m.id)}
                      title="Remove member"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Member UPI Row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 38 }}>
                    {isEditingThisUpi ? (
                      <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                        <input
                          className="input input-mono input-sm"
                          placeholder="e.g. name@okhdfcbank"
                          value={tempUpi}
                          onChange={e => setTempUpi(e.target.value)}
                          autoFocus
                          style={{ flex: 1, fontSize: '0.78rem' }}
                        />
                        <button className="btn btn-primary btn-xs" onClick={() => saveMemberUpi(m.id)}>Save</button>
                        <button className="btn btn-ghost btn-xs" onClick={() => setEditingUpiId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.76rem' }}>
                        <span style={{ color: 'var(--ink-muted)' }}>UPI:</span>
                        {m.upi ? (
                          <span
                            className="input-mono"
                            style={{ color: 'var(--ink-secondary)', fontWeight: 600, cursor: 'pointer', background: 'rgba(0,0,0,0.04)', padding: '2px 6px', borderRadius: 4 }}
                            onClick={() => { setEditingUpiId(m.id); setTempUpi(m.upi); }}
                            title="Click to edit UPI ID"
                          >
                            {m.upi} ✏️
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            style={{ color: 'var(--accent-blue)', padding: '2px 6px' }}
                            onClick={() => { setEditingUpiId(m.id); setTempUpi(''); }}
                          >
                            + Add UPI ID
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save Changes</button>
        </div>
      </div>
    </div>,
    document.body
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
        const payerColor = payer?.color || (memberIdx >= 0 ? getMemberColor(memberIdx) : 'var(--accent-violet)');
        return (
          <div key={exp.id} className="expense-item">
            <div className="expense-icon" style={{ background: payerColor, color: '#fff' }}>
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

// ===== UPI PAYMENT & QR MODAL =====
function UPIPaymentModal({ tx, group, onClose, onSettled }) {
  const { from, to, amountPaise, settled } = tx;
  const myName = localStorage.getItem('splitsmart_my_name') || '';
  const myUpi = localStorage.getItem('splitsmart_my_upi') || '';
  const isToMe = (myName && to?.name?.toLowerCase().trim() === myName.toLowerCase().trim()) || to?.isMe;
  const initialUpi = to?.upi || (isToMe && myUpi) || `${to?.name?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'payee'}@okaxis`;
  
  const [upiId, setUpiId] = useState(initialUpi);
  const [qrUrl, setQrUrl] = useState('');
  const toast = useToast();

  const handleSaveUpi = async () => {
    if (!upiId.trim()) return;
    const cleanUpi = upiId.trim();
    if (group) {
      const updatedMembers = group.members.map(m => m.id === to?.id ? { ...m, upi: cleanUpi } : m);
      await dbOps.saveGroup({ ...group, members: updatedMembers });
    }
    if (isToMe) {
      localStorage.setItem('splitsmart_my_upi', cleanUpi);
      window.dispatchEvent(new Event('splitsmart_profile_updated'));
    }
    toast(`Saved UPI ID for ${to?.name || 'payee'}!`, 'success');
  };

  const upiLink = generateUPILink({
    payeeUPI: upiId,
    payeeName: to?.name || '',
    amount: amountPaise,
    note: `SplitSmart - ${group?.name || 'Bill Settlement'}`,
  });

  useEffect(() => {
    QRCode.toDataURL(upiLink, {
      width: 240,
      margin: 1,
      color: { dark: '#06060f', light: '#ffffff' },
    }).then(setQrUrl).catch(err => console.error('QR generation failed:', err));
  }, [upiLink]);

  const copyToClipboard = (text, msg) => {
    navigator.clipboard?.writeText(text).then(() => {
      toast(msg, 'success');
    }).catch(() => {
      toast('Failed to copy', 'error');
    });
  };

  const suffixes = ['@okhdfcbank', '@oksbi', '@paytm', '@ybl', '@okaxis'];

  return createPortal(
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal-content animate-scaleIn" onClick={e => e.stopPropagation()} style={{ maxWidth: 440, textAlign: 'center', margin: 'auto' }}>
        <div className="modal-header">
          <h2 className="modal-title" style={{ fontSize: '1.15rem' }}>📱 UPI Payment & QR</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          {/* Transfer direction */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{from?.name}</span>
            <span style={{ color: 'var(--accent-cyan)' }}>→ pays →</span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{to?.name} {isToMe ? '(You)' : ''}</span>
          </div>

          {/* Amount banner */}
          <div style={{
            fontSize: '1.9rem',
            fontWeight: 800,
            fontFamily: 'var(--font-mono)',
            color: 'var(--accent-emerald)',
            letterSpacing: '-0.5px'
          }}>
            {formatCurrency(amountPaise)}
          </div>

          {/* Scannable QR Code */}
          <div className="qr-container" style={{ boxShadow: '0 8px 30px rgba(0,0,0,0.12)', borderRadius: 16, padding: 12, background: '#ffffff' }}>
            {qrUrl ? (
              <img src={qrUrl} alt="UPI QR Code" style={{ width: 220, height: 220, display: 'block' }} />
            ) : (
              <div style={{ width: 220, height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#333' }}>
                Generating QR...
              </div>
            )}
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Scan with any UPI app (GPay, PhonePe, Paytm, BHIM)
          </div>

          {/* Payee UPI ID */}
          <div style={{ width: '100%', textAlign: 'left', marginTop: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <label className="label" style={{ fontSize: '0.75rem', margin: 0 }}>Payee UPI ID</label>
              {isToMe && (
                <span className="badge badge-cyan" style={{ fontSize: '0.68rem' }}>⭐ Your Personal UPI</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input input-mono input-sm"
                value={upiId}
                onChange={e => setUpiId(e.target.value)}
                placeholder="payee@bank"
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => copyToClipboard(upiId, 'UPI ID copied!')}
                title="Copy UPI ID">
                📋
              </button>
            </div>
            {/* Quick suffix chips + Save button */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', gap: 6 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {suffixes.map(sfx => (
                  <button
                    key={sfx}
                    type="button"
                    className="badge badge-glass"
                    style={{ cursor: 'pointer', fontSize: '0.65rem' }}
                    onClick={() => {
                      const prefix = upiId.split('@')[0] || to?.name?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'payee';
                      setUpiId(prefix + sfx);
                    }}>
                    {sfx}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={handleSaveUpi}
                title="Save this UPI ID for future settlements"
                style={{ fontSize: '0.72rem', border: '1px solid var(--border-subtle)' }}
              >
                💾 Remember UPI
              </button>
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button
            className="btn btn-ghost"
            style={{ flex: 1 }}
            onClick={() => copyToClipboard(upiLink, 'UPI Deep Link copied!')}>
            📋 Copy Link
          </button>
          <a
            href={upiLink}
            className="btn btn-secondary"
            style={{ flex: 1, textAlign: 'center' }}>
            ⚡ Open App
          </a>
          <button
            className="btn btn-success"
            style={{ flex: 1 }}
            onClick={onSettled}>
            {settled ? 'Undo Settle' : '✓ Mark Settled'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ===== SETTLE TAB =====
function SettleTab({ expenses, members, groupId, group }) {
  const balances = computeNetBalances(expenses, members);
  const transactions = simplifyDebts(balances);
  const [settlements, setSettlements] = useState([]);
  const [selectedTx, setSelectedTx] = useState(null);
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
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => setSelectedTx({ ...tx, index: i, from, to, settled })}
                    title="Pay via UPI or scan QR">
                    📱 QR / Pay
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {selectedTx && (
        <UPIPaymentModal
          tx={selectedTx}
          group={group}
          onClose={() => setSelectedTx(null)}
          onSettled={() => {
            toggleSettle(selectedTx.index);
            setSelectedTx(null);
          }}
        />
      )}
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

function ReceiptScanner() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const groupId = params.groupId || 'jugadu-cafe';
  const [scannerTab, setScannerTab] = useState(searchParams.get('tab') === 'text' ? 'text' : 'photo'); // 'photo' | 'text'
  const [pastedText, setPastedText] = useState('');
  const [imageData, setImageData] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  const { startCamera, stopCamera, capturePhoto, stream, error: camError, videoRef } = useCamera();
  const [showCamera, setShowCamera] = useState(false);
  const { recognize, progress, status, isProcessing } = useOCR();
  const [rotation, setRotation] = useState(0);

  const sampleTexts = {
    ab: `Absolute Barbecues
AB's-POWAI
Mumbai, Maharashtra - 400072

Masala Margarita
1 @ 169/ea 169.00
Water Btl
3 @ 20/ea 60.00
TT Dinner sun nvg
4 @ 999.75/ea 3,999.00

Sub Total 4,228.00
CGST 2.5 2.5% on 4,228.00 105.70
SGST 2.5 2.5% on 4,228.00 105.70

Bill Total 4,439.40`,
    canteen: `NIGHT CANTEEN & CAFE
Hostel Wing 4, Campus Grounds
Order #4082

Paneer Butter Masala 180.00
3 Butter Naan 120.00
Dal Makhani 150.00
Jeera Rice 110.00
2 Cold Coffee 160.00

Sub Total: 720.00
CGST 2.5%: 18.00
SGST 2.5%: 18.00
Total: 756.00`,
  };

  const handlePastedTextProcess = () => {
    if (!pastedText.trim()) {
      toast('Please paste or type your receipt text first', 'warning');
      return;
    }
    try {
      const parsed = parseReceipt({ text: pastedText });
      if (!parsed.items || parsed.items.length === 0) {
        toast('No items detected in text. Make sure items have prices (e.g. Masala Coke 200.00)', 'warning');
        return;
      }
      sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
      sessionStorage.setItem('ocrResult', JSON.stringify({ text: pastedText }));
      sessionStorage.removeItem('receiptImage');
      toast(`Successfully parsed ${parsed.items.length} items from text!`, 'success');
      navigate(`/group/${groupId}/review`);
    } catch (err) {
      toast('Failed to parse text: ' + err.message, 'error');
    }
  };

  const handleFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) {
      toast('Please select an image file', 'warning');
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    setImageData(dataUrl);
    toast('Image loaded! Click "Process Bill" to parse.', 'info');
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
      toast('Photo captured! Click "Process Bill" to parse.', 'info');
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
      const normalized = await preprocessImage(imageData);
      const ocrResult = await recognize(normalized || imageData);
      const parsed = parseReceipt(ocrResult);
      try {
        sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
        sessionStorage.setItem('receiptImage', imageData);
        sessionStorage.setItem('ocrResult', JSON.stringify({ text: ocrResult?.text || '' }));
      } catch {
        sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
      }

      toast('Receipt parsed successfully!', 'success');
      navigate(`/group/${groupId}/review`);
    } catch (err) {
      toast('OCR failed: ' + err.message, 'error');
    }
  };

  const openCamera = async () => {
    const s = await startCamera();
    if (s) setShowCamera(true);
  };

  const loadBombayCanteenBill = () => {
    const parsed = {
      items: [
        { id: generateId(), name: 'MASALA COKE', qty: 1, unitPricePaise: 20000, totalPaise: 20000, assignees: [] },
        { id: generateId(), name: "TZ'S ELIXIR", qty: 1, unitPricePaise: 20000, totalPaise: 20000, assignees: [] },
        { id: generateId(), name: 'CHETTINAD PRAWNS', qty: 1, unitPricePaise: 40000, totalPaise: 40000, assignees: [] },
        { id: generateId(), name: 'B**F FRY', qty: 1, unitPricePaise: 37500, totalPaise: 37500, assignees: [] },
        { id: generateId(), name: 'MALABAR PARATHA', qty: 3, unitPricePaise: 9000, totalPaise: 27000, assignees: [] },
        { id: generateId(), name: 'BARLEY SALAD', qty: 1, unitPricePaise: 22500, totalPaise: 22500, assignees: [] },
        { id: generateId(), name: 'MUTTON CURRY', qty: 1, unitPricePaise: 32500, totalPaise: 32500, assignees: [] },
        { id: generateId(), name: 'COFFEE RASGULLA', qty: 1, unitPricePaise: 35000, totalPaise: 35000, assignees: [] },
        { id: generateId(), name: 'MANGO TRIFLE', qty: 1, unitPricePaise: 15000, totalPaise: 15000, assignees: [] },
      ],
      taxes: [
        { name: 'Service Tax 5.80%', amountPaise: 15918 },
        { name: 'VAT ON CARB BEV 25%', amountPaise: 5500 },
        { name: 'VAT ON FOOD 12.5%', amountPaise: 31556 },
      ],
      serviceCharge: 24950,
      discount: 0,
      roundoff: 76,
      total: 327500,
      rawText: 'THE BOMBAY CANTEEN...'
    };

    sessionStorage.setItem('ocrResult', JSON.stringify({ lines: [] }));
    sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
    toast('Loaded Bombay Canteen Bill (₹3,275)! Proceeding to assign items.', 'success');
    navigate(`/group/${groupId}/review`);
  };

  const loadABBill = () => {
    const parsed = {
      items: [
        { id: generateId(), name: 'Masala Margarita', qty: 1, unitPricePaise: 16900, totalPaise: 16900, assignees: [] },
        { id: generateId(), name: 'Water Btl', qty: 3, unitPricePaise: 2000, totalPaise: 6000, assignees: [] },
        { id: generateId(), name: 'TT Dinner sun nvg', qty: 4, unitPricePaise: 99975, totalPaise: 399900, assignees: [] },
      ],
      taxes: [
        { name: 'CGST 2.5% on 4,228.00', amountPaise: 10570 },
        { name: 'SGST 2.5% on 4,228.00', amountPaise: 10570 },
      ],
      serviceCharge: 0,
      discount: 0,
      roundoff: 0,
      total: 443940,
      rawText: "Absolute Barbecues - Bill Total 4,439.40"
    };

    sessionStorage.setItem('ocrResult', JSON.stringify({ lines: [] }));
    sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
    toast('Loaded Absolute Barbecues Bill (₹4,439.40)! Proceeding to assign items.', 'success');
    navigate(`/group/${groupId}/review`);
  };

  const handleInstantDemo = () => {
    const parsed = {
      items: [
        { id: generateId(), name: '1. Coca Cola 2ltr', qty: 1, unitPricePaise: 2570, totalPaise: 2570, assignees: [] },
        { id: generateId(), name: '2. Medium Pommes', qty: 1, unitPricePaise: 12520, totalPaise: 12520, assignees: [] },
        { id: generateId(), name: '3. Chicken Burger', qty: 1, unitPricePaise: 1530, totalPaise: 1530, assignees: [] },
        { id: generateId(), name: '4. Aloo Tikkey', qty: 1, unitPricePaise: 2450, totalPaise: 2450, assignees: [] },
        { id: generateId(), name: '5. McFlurry Oreo', qty: 1, unitPricePaise: 12000, totalPaise: 12000, assignees: [] },
      ],
      taxes: [],
      serviceCharge: 0,
      discount: 0,
      roundoff: 0,
      total: 31070,
      rawText: "Demo Lunch Bill - Total $310.70"
    };

    sessionStorage.setItem('ocrResult', JSON.stringify({ lines: [] }));
    sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
    toast('Loaded demo bill! Proceeding to item assignment.', 'success');
    navigate(`/group/${groupId}/review`);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Link to={`/group/${groupId}`} className="btn btn-ghost btn-icon">←</Link>
          <h1 className="page-title">Add Receipt / Bill</h1>
        </div>
      </div>

      {/* Mode Switcher: Photo Scan vs Paste Bill Text */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button
          type="button"
          className={`btn btn-sm ${scannerTab === 'photo' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setScannerTab('photo')}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          📸 Photo / Upload Scan
        </button>
        <button
          type="button"
          className={`btn btn-sm ${scannerTab === 'text' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setScannerTab('text')}
          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          📋 Paste Bill Text (No Scan)
        </button>
      </div>

      {/* MODE 2: Paste Raw Bill Text (Skip OCR entirely) */}
      {scannerTab === 'text' && (
        <div className="animate-fadeIn card" style={{ padding: 20 }}>
          <div style={{ marginBottom: 14 }}>
            <label className="label" style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
              Paste Receipt Text directly
            </label>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              No image scanning required! Paste raw text from SMS, WhatsApp, digital receipts, or delivery apps.
            </p>
          </div>

          <textarea
            className="input"
            rows={10}
            value={pastedText}
            onChange={e => setPastedText(e.target.value)}
            placeholder={`Example:\nMasala Margarita\n1 @ 169/ea 169.00\nWater Btl\n3 @ 20/ea 60.00\nTT Dinner sun nvg\n4 @ 999.75/ea 3,999.00\nSub Total: 4,228.00\nCGST 2.5%: 105.70\nSGST 2.5%: 105.70\nBill Total: 4,439.40`}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.85rem', lineHeight: 1.5, resize: 'vertical', background: 'rgba(5, 5, 12, 0.6)' }}
          />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Try Sample:</span>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setPastedText(sampleTexts.ab)}>
                🍖 Absolute BBQ
              </button>
              <button type="button" className="btn btn-xs btn-ghost" onClick={() => setPastedText(sampleTexts.canteen)}>
                🍛 Canteen
              </button>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handlePastedTextProcess}
              disabled={!pastedText.trim()}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              ⚡ Parse Text & Review →
            </button>
          </div>
        </div>
      )}

      {/* MODE 1: Photo / Camera Scan */}
      {scannerTab === 'photo' && (
        <>

      {/* Hidden File Input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={e => {
          if (e.target.files?.[0]) handleFile(e.target.files[0]);
        }}
      />

      {/* Viewfinder Card with Corner Brackets & Sweeping Laser */}
      <div className="scanner-viewfinder-card">
        {/* 4 Blue Rounded Corner Brackets */}
        <div className="vf-corner vf-corner-tl" />
        <div className="vf-corner vf-corner-tr" />
        <div className="vf-corner vf-corner-bl" />
        <div className="vf-corner vf-corner-br" />

        {/* Animated Glowing Laser Scan Beam */}
        <div className="vf-scan-beam" />

        {/* Live Camera View */}
        {showCamera ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <video
              ref={el => {
                videoRef.current = el;
                if (el && stream && el.srcObject !== stream) el.srcObject = stream;
              }}
              autoPlay
              playsInline
              style={{ width: '100%', maxHeight: 420, borderRadius: 16, objectFit: 'cover' }}
            />
            <div style={{ display: 'flex', gap: 12, marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={() => { stopCamera(); setShowCamera(false); }}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleCameraCapture}>
                📸 Snap Photo
              </button>
            </div>
          </div>
        ) : isProcessing ? (
          /* Processing State */
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div className="spinner" style={{ margin: '0 auto 20px', width: 44, height: 44 }} />
            <div style={{ fontWeight: 800, fontSize: '1.2rem', color: 'var(--ink-primary)', marginBottom: 8 }}>
              Parsing Receipt with OCR...
            </div>
            <div style={{ fontSize: '0.9rem', color: 'var(--ink-muted)', marginBottom: 16 }}>{status}</div>
            <div className="progress-bar" style={{ width: 280, margin: '0 auto' }}>
              <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginTop: 8 }}>{progress}%</div>
          </div>
        ) : imageData ? (
          /* Image Preview inside Corner Brackets */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
            <img
              src={imageData}
              alt="Receipt preview"
              style={{ maxHeight: 380, maxWidth: '100%', borderRadius: 12, objectFit: 'contain', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}
            />
            <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn btn-ghost" onClick={() => { setImageData(null); setRotation(0); }}>
                ↩ Retake
              </button>
              <button className="btn btn-secondary" onClick={handleRotate}>
                🔄 Rotate
              </button>
              <button className="btn btn-primary btn-lg" onClick={handleProcess}>
                ⚡ Process Bill &amp; Assign Items
              </button>
            </div>
          </div>
        ) : (
          /* Drag & Drop Upload State */
          <div
            className={`dropzone-box ${dragging ? 'dragging' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <div className="dropzone-icon">📸</div>
            <div className="dropzone-title">Drop your receipt image here</div>
            <div className="dropzone-hint">or click to browse from device (JPG, PNG)</div>
            <div style={{ marginTop: 20, display: 'flex', gap: 10, justifyContent: 'center' }} onClick={e => e.stopPropagation()}>
              <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
                📁 Browse File
              </button>
              <button className="btn btn-secondary btn-sm" onClick={openCamera}>
                📷 Use Camera
              </button>
            </div>
            {camError && (
              <div style={{ marginTop: 12, color: 'var(--accent-amber)', fontSize: '0.82rem' }}>
                ⚠️ {camError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Verified Sample Bills Bar */}
      <div className="sample-bills-bar">
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--ink-primary)' }}>
            ✨ Don't have a receipt handy?
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
            Test with our real restaurant bills and verified OCR:
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" onClick={loadBombayCanteenBill}>
            🍛 Bombay Canteen (₹3,275)
          </button>
          <button className="btn btn-secondary btn-sm" onClick={loadABBill}>
            🍖 Absolute Barbecues (₹4,439)
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleInstantDemo}>
            ⚡ Instant Demo ($310.70)
          </button>
        </div>
      </div>
        </>
      )}
    </div>
  );
}

// ===== ARROW-LESS NATURAL PRICE & QTY INPUTS =====
/**
 * Arrow-less, natural typing price input storing integer paise.
 * - Auto-selects on focus so clicking immediately enables replacing the number.
 * - Eliminates browser stepper arrows (no more holding arrows).
 * - Doesn't fight the user with .toFixed(2) mid-keystroke.
 * - Commits clean integer paise on blur / Enter key.
 */
function PriceInput({
  valuePaise,
  onChange,
  allowNegative = false,
  className = 'input input-sm input-mono',
  style = {},
  placeholder = '0.00',
  id,
  name
}) {
  const [isFocused, setIsFocused] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!isFocused) {
      if (valuePaise === 0 || valuePaise === undefined || valuePaise === null) {
        setText('0.00');
      } else {
        setText((valuePaise / 100).toFixed(2));
      }
    }
  }, [valuePaise, isFocused]);

  const handleFocus = (e) => {
    setIsFocused(true);
    e.target.select();
  };

  const handleChange = (e) => {
    const raw = e.target.value;
    let filtered = allowNegative
      ? raw.replace(/(?!^)-|[^0-9.-]/g, '')
      : raw.replace(/[^0-9.]/g, '');

    const parts = filtered.split('.');
    if (parts.length > 2) {
      filtered = parts[0] + '.' + parts.slice(1).join('');
    }
    setText(filtered);

    if (filtered !== '' && filtered !== '-' && filtered !== '.') {
      const num = parseFloat(filtered);
      if (!isNaN(num)) {
        onChange(Math.round(num * 100));
      }
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    let num = parseFloat(text);
    if (isNaN(num)) num = 0;
    if (!allowNegative && num < 0) num = 0;
    const paise = Math.round(num * 100);
    onChange(paise);
    setText((paise / 100).toFixed(2));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.target.blur();
    }
  };

  return (
    <input
      id={id}
      name={name}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      style={{
        ...style,
      }}
      placeholder={placeholder}
      value={isFocused ? text : (valuePaise !== undefined ? (valuePaise / 100).toFixed(2) : '0.00')}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}

/**
 * Arrow-less, natural typing quantity input.
 * - Auto-selects on focus so clicking immediately enables replacing the number.
 * - No stepper arrows.
 * - Minimum quantity 1.
 */
function QtyInput({ value, onChange, style = {} }) {
  const [isFocused, setIsFocused] = useState(false);
  const [text, setText] = useState(String(value || 1));

  useEffect(() => {
    if (!isFocused) setText(String(value || 1));
  }, [value, isFocused]);

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className="input input-sm input-mono"
      style={style}
      value={isFocused ? text : (value || 1)}
      onFocus={(e) => {
        setIsFocused(true);
        e.target.select();
      }}
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^0-9]/g, '');
        setText(cleaned);
        const parsed = parseInt(cleaned, 10);
        if (parsed > 0) onChange(parsed);
      }}
      onBlur={() => {
        setIsFocused(false);
        const parsed = parseInt(text, 10);
        const finalQty = parsed > 0 ? parsed : 1;
        onChange(finalQty);
        setText(String(finalQty));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur();
      }}
    />
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
  const [roundoff, setRoundoff] = useState(0);
  const [total, setTotal] = useState(0);
  const [receiptImage, setReceiptImage] = useState(null);
  const [validation, setValidation] = useState(null);
  const [step, setStep] = useState('review'); // review → assign → split → done
  const [payer, setPayer] = useState('');
  const [description, setDescription] = useState('');
  const [splitMode, setSplitMode] = useState('itemized');
  const [customSplits, setCustomSplits] = useState({});
  const [showRawOCR, setShowRawOCR] = useState(false);
  const [receiptZoom, setReceiptZoom] = useState(1.0);
  const [showImageLightbox, setShowImageLightbox] = useState(false);
  const [mobileTab, setMobileTab] = useState('items'); // 'receipt' | 'items'
  const { addExpense } = useExpenses(groupId);

  const handleReparseOCR = () => {
    const ocrStr = sessionStorage.getItem('ocrResult');
    if (!ocrStr) {
      toast('No raw OCR text found. Open "Raw OCR" to paste receipt lines.', 'warning');
      return;
    }
    try {
      const rawOcr = JSON.parse(ocrStr);
      const reParsed = parseReceipt(rawOcr);
      if (reParsed.items && reParsed.items.length > 0) {
        setItems(reParsed.items);
        if (reParsed.taxes && reParsed.taxes.length > 0) setTaxes(reParsed.taxes);
        if (reParsed.serviceCharge !== undefined) setServiceCharge(reParsed.serviceCharge || 0);
        if (reParsed.discount !== undefined) setDiscount(reParsed.discount || 0);
        if (reParsed.roundoff !== undefined) setRoundoff(reParsed.roundoff || 0);
        if (reParsed.total) setTotal(reParsed.total);
        toast(`Parsed ${reParsed.items.length} items successfully!`, 'success');
      } else {
        toast('No items detected in raw OCR text', 'warning');
      }
    } catch (err) {
      toast('Failed to re-parse: ' + err.message, 'error');
    }
  };

  useEffect(() => {
    const resolveGroup = async () => {
      let g = await dbOps.getGroup(groupId);
      if (!g) {
        const all = await dbOps.getAllGroups();
        if (all.length > 0) {
          g = all.find(x => x.id === groupId) || all[0];
        } else {
          g = {
            id: groupId || 'jugadu-cafe',
            name: 'Jugadu Cafe',
            members: [
              { id: 'm1', name: 'You' },
              { id: 'm2', name: 'Jerry' },
              { id: 'm3', name: 'Danny' },
              { id: 'm4', name: 'Richard' },
            ],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await dbOps.saveGroup(g);
        }
      }
      setGroup(g);
      if (g.members && g.members.length > 0) setPayer(g.members[0].id);
    };

    resolveGroup().catch(console.error);

    // Load parsed data from sessionStorage
    const parsedStr = sessionStorage.getItem('parsedReceipt');
    const ocrStr = sessionStorage.getItem('ocrResult');
    const imgStr = sessionStorage.getItem('receiptImage');

    if (parsedStr) {
      let parsed = JSON.parse(parsedStr);
      let loadedItems = parsed.items || [];

      // Auto re-parse if stored ocrResult can extract clean items or purge bogus headers
      if (ocrStr) {
        try {
          const rawOcr = JSON.parse(ocrStr);
          const reParsed = parseReceipt(rawOcr);
          const hasBogusHeader = loadedItems.some(i => /table|stl/i.test(i.name));
          const hasArtifacts = loadedItems.some(i => /^[^a-zA-Z0-9]/.test(i.name) || /^\d+["'`]/.test(i.name));
          if (reParsed.items && (reParsed.items.length > loadedItems.length || hasBogusHeader || hasArtifacts)) {
            loadedItems = reParsed.items;
            if (reParsed.taxes && reParsed.taxes.length > 0) parsed.taxes = reParsed.taxes;
            if (reParsed.serviceCharge !== undefined) parsed.serviceCharge = reParsed.serviceCharge;
            if (reParsed.discount !== undefined) parsed.discount = reParsed.discount;
            if (reParsed.roundoff !== undefined) parsed.roundoff = reParsed.roundoff;
            if (reParsed.total) parsed.total = reParsed.total;
          }
        } catch { /* ignore fallback error */ }
      }

      // Ensure all loaded item names are cleanly sanitized
      loadedItems = loadedItems.map(item => ({
        ...item,
        name: cleanItemName(item.name)
      }));

      setItems(loadedItems);
      setTaxes(parsed.taxes || []);
      setServiceCharge(parsed.serviceCharge || 0);
      setDiscount(parsed.discount || 0);
      setRoundoff(parsed.roundoff || 0);
      setTotal(parsed.total || 0);
    } else {
      // Default reference items from the screenshot
      setItems([
        { id: '1', name: '1. Coca Cola 2ltr', qty: 1, unitPricePaise: 2570, totalPaise: 2570, assignees: [] },
        { id: '2', name: '2. Medium Pommes', qty: 1, unitPricePaise: 12520, totalPaise: 12520, assignees: [] },
        { id: '3', name: '3. Chicken Burger', qty: 1, unitPricePaise: 1530, totalPaise: 1530, assignees: [] },
        { id: '4', name: '4. Aloo Tikkey', qty: 1, unitPricePaise: 2450, totalPaise: 2450, assignees: [] },
        { id: '5', name: '5. McFlurry Oreo', qty: 1, unitPricePaise: 12000, totalPaise: 12000, assignees: [] },
      ]);
      setTotal(31070);
    }
    if (imgStr) setReceiptImage(imgStr);
  }, [groupId]);

  // Validate whenever items/taxes/charges change
  useEffect(() => {
    const receipt = { items, taxes, serviceCharge, discount, roundoff, total };
    setValidation(validateTotal(receipt));
  }, [items, taxes, serviceCharge, discount, roundoff, total]);

  const updateItem = (idx, field, value) => {
    const updated = [...items];
    if (field === 'totalPaise' || field === 'unitPricePaise') {
      updated[idx][field] = typeof value === 'number' ? value : (Math.round(parseFloat(value) * 100) || 0);
    } else if (field === 'qty') {
      updated[idx][field] = typeof value === 'number' ? value : (parseInt(value, 10) || 1);
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
      const result = calculateItemizedSplit({ items, taxes, serviceCharge, discount, roundoff });
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

    await addExpense({
      description: description || 'Receipt Expense',
      totalPaise: totalPaise || total,
      payerId: payer,
      date: Date.now(),
      items,
      taxes,
      serviceCharge,
      discount,
      roundoff,
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
                background: step === s ? 'var(--accent-blue)' : 'var(--bg-glass)',
                color: step === s ? '#ffffff' : 'inherit',
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
          {/* Mobile view toggle */}
          {receiptImage && (
            <div className="review-mobile-nav">
              <button
                type="button"
                className={`btn btn-sm ${mobileTab === 'receipt' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setMobileTab('receipt')}
              >
                🧾 View Receipt
              </button>
              <button
                type="button"
                className={`btn btn-sm ${mobileTab === 'items' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setMobileTab('items')}
              >
                📝 Edit Items ({items.length})
              </button>
            </div>
          )}

          <div className="review-layout">
            {/* Receipt image with zoom controls & dedicated scrollbar */}
            {receiptImage && (
              <div className={`review-image-card ${mobileTab === 'items' ? 'review-col-hidden-mobile' : ''}`}>
                <div className="review-image-header">
                  <div className="review-image-title">
                    <span>🧾 Receipt Preview</span>
                  </div>
                  <div className="review-image-controls">
                    <button
                      type="button"
                      className="review-control-btn"
                      onClick={() => setReceiptZoom(z => Math.max(0.6, +(z - 0.2).toFixed(1)))}
                      title="Zoom Out"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="review-control-btn"
                      onClick={() => setReceiptZoom(1.0)}
                      title="Reset Zoom to 100%"
                      style={{ minWidth: 46 }}
                    >
                      {Math.round(receiptZoom * 100)}%
                    </button>
                    <button
                      type="button"
                      className="review-control-btn"
                      onClick={() => setReceiptZoom(z => Math.min(2.5, +(z + 0.2).toFixed(1)))}
                      title="Zoom In"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="review-control-btn"
                      onClick={() => setShowImageLightbox(true)}
                      title="Expand Fullscreen"
                      style={{ marginLeft: 4 }}
                    >
                      ⛶
                    </button>
                  </div>
                </div>

                <div className="review-image-viewport">
                  <img
                    src={receiptImage}
                    alt="Receipt"
                    className="review-receipt-img"
                    style={{
                      width: `${Math.round(receiptZoom * 100)}%`,
                      maxWidth: receiptZoom === 1.0 ? '100%' : 'none',
                    }}
                    onClick={() => setShowImageLightbox(true)}
                    title="Click to view full screen"
                  />
                </div>

                <div className="review-image-footer">
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/group/${groupId}/scan`)}>
                      📸 Re-scan
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={handleReparseOCR}>
                      ⚡ Re-parse Text
                    </button>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--ink-muted)' }}>
                    Scroll to view bill
                  </span>
                </div>
              </div>
            )}
            
            {/* Parsed items table */}
            <div className={mobileTab === 'receipt' ? 'review-col-hidden-mobile' : ''}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0, color: 'var(--ink-primary)' }}>Parsed Items</h3>
                  <span style={{ fontSize: '0.85rem', color: 'var(--ink-muted)' }}>({items.length})</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => setShowRawOCR(true)} title="View & edit raw OCR text">
                    📜 Raw OCR
                  </button>
                  <button className="btn btn-sm btn-secondary" onClick={handleReparseOCR} title="Re-parse with smart heuristics">
                    ⚡ Re-parse
                  </button>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={async () => {
                      toast('🤖 Running MobileBERT Zero-Shot AI Categorization...', 'info');
                      try {
                        const { classifyItems } = await import('./logic/categorizer');
                        const updated = await classifyItems(items);
                        setItems(updated);
                        toast('✨ All items categorized with MobileBERT!', 'success');
                      } catch (err) {
                        toast('AI Categorizer: ' + err.message, 'warning');
                      }
                    }}
                    title="Classify items with Xenova/mobilebert-uncased-mnli"
                  >
                    🤖 AI Categorize
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={addItem}>+ Add Item</button>
                </div>
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
                          <div style={{ marginTop: 4 }}>
                            <select
                              className={`category-pill ${CATEGORIES[item.category]?.cssClass || 'category-other'}`}
                              value={item.category || 'Other'}
                              onChange={e => updateItem(idx, 'category', e.target.value)}
                              style={{ cursor: 'pointer', border: 'none', padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600 }}
                            >
                              {Object.keys(CATEGORIES).map(cat => (
                                <option key={cat} value={cat} style={{ background: '#1c1b22', color: '#fff' }}>
                                  {CATEGORIES[cat]?.emoji} {cat}
                                </option>
                              ))}
                            </select>
                          </div>
                        </td>
                        <td>
                          <QtyInput
                            value={item.qty}
                            onChange={q => updateItem(idx, 'qty', q)}
                            style={{ width: 50, textAlign: 'center' }}
                          />
                        </td>
                        <td>
                          <PriceInput
                            valuePaise={item.unitPricePaise}
                            onChange={p => updateItem(idx, 'unitPricePaise', p)}
                            style={{ width: 85, textAlign: 'right' }}
                          />
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
              <div style={{ marginTop: 16, padding: 18, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--ink-primary)' }}>Taxes &amp; Additional Charges</span>
                  <button type="button" className="btn btn-sm btn-ghost" style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                    onClick={() => setTaxes([...taxes, { name: 'GST', amountPaise: 0 }])}>
                    + Add Tax
                  </button>
                </div>
                {taxes.map((tax, idx) => (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                    <input className="input input-sm" value={tax.name} 
                      onChange={e => { const t = [...taxes]; t[idx].name = e.target.value; setTaxes(t); }}
                      placeholder="Tax Name (e.g. GST)"
                      style={{ flex: 1, minWidth: 120, background: 'transparent' }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: 'var(--ink-muted)' }}>₹</span>
                      <PriceInput
                        valuePaise={tax.amountPaise}
                        onChange={p => {
                          const t = [...taxes];
                          t[idx].amountPaise = p;
                          setTaxes(t);
                        }}
                        style={{ width: 85, textAlign: 'right' }}
                      />
                      <button type="button" className="btn btn-ghost btn-icon" style={{ fontSize: '0.75rem', padding: '2px 6px', color: '#ef4444' }}
                        title="Delete tax" onClick={() => setTaxes(taxes.filter((_, i) => i !== idx))}>
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
                {serviceCharge > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--ink-secondary)' }}>Service Charge</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: 'var(--ink-muted)' }}>₹</span>
                      <PriceInput
                        valuePaise={serviceCharge}
                        onChange={setServiceCharge}
                        style={{ width: 85, textAlign: 'right' }}
                      />
                    </div>
                  </div>
                )}
                {roundoff !== 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: '0.85rem' }}>
                    <span style={{ color: 'var(--ink-secondary)' }}>Adjustments / Round Off</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: 'var(--ink-muted)' }}>₹</span>
                      <PriceInput
                        valuePaise={roundoff}
                        allowNegative={true}
                        onChange={setRoundoff}
                        style={{ width: 85, textAlign: 'right' }}
                      />
                    </div>
                  </div>
                )}
                {discount > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, fontSize: '0.85rem' }}>
                    <span style={{ color: '#10b981' }}>Discount</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: '#10b981' }}>-₹</span>
                      <PriceInput
                        valuePaise={discount}
                        onChange={setDiscount}
                        style={{ width: 85, textAlign: 'right', color: '#10b981' }}
                      />
                    </div>
                  </div>
                )}
                <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10, display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                  <span style={{ color: 'var(--ink-primary)' }}>Total</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>₹</span>
                    <PriceInput
                      valuePaise={total}
                      onChange={setTotal}
                      style={{ width: 100, fontWeight: 700, textAlign: 'right' }}
                    />
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

      {/* Lightbox Modal */}
      {showImageLightbox && receiptImage && (
        <div className="modal-backdrop animate-fadeIn" onClick={() => setShowImageLightbox(false)} style={{ zIndex: 9999 }}>
          <div
            className="modal glass-card"
            style={{ maxWidth: '92vw', maxHeight: '92vh', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e5e7eb' }}>
              <span style={{ fontWeight: 700, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                🧾 Full Receipt Image (High Resolution)
              </span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setShowImageLightbox(false)}
                style={{ borderRadius: '50%', width: 32, height: 32, padding: 0 }}
                title="Close"
              >
                ✕
              </button>
            </div>
            <div style={{ overflow: 'auto', padding: 20, display: 'flex', justifyContent: 'center', background: '#f8fafc' }}>
              <img
                src={receiptImage}
                alt="Receipt Fullscreen"
                style={{ maxWidth: '100%', height: 'auto', display: 'block', borderRadius: 8 }}
              />
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
                  <input className="input input-sm input-mono" type="text" inputMode="decimal"
                    value={customSplits[m.id] !== undefined ? customSplits[m.id] : ''} placeholder="0"
                    onFocus={e => e.target.select()}
                    onChange={e => {
                      const val = e.target.value.replace(/[^0-9.]/g, '');
                      setCustomSplits({ ...customSplits, [m.id]: parseFloat(val) || 0 });
                    }}
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
                  <input className="input input-sm input-mono" type="text" inputMode="numeric"
                    value={customSplits[m.id] !== undefined ? customSplits[m.id] : ''} placeholder="1"
                    onFocus={e => e.target.select()}
                    onChange={e => {
                      const val = e.target.value.replace(/[^0-9]/g, '');
                      setCustomSplits({ ...customSplits, [m.id]: parseInt(val, 10) || 0 });
                    }}
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
              const result = calculateItemizedSplit({ items, taxes, serviceCharge, discount, roundoff });
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

      {showRawOCR && (
        <RawOCRModal
          initialText={(() => {
            try {
              const ocr = JSON.parse(sessionStorage.getItem('ocrResult') || '{}');
              return ocr.text || '';
            } catch { return ''; }
          })()}
          onClose={() => setShowRawOCR(false)}
          onApplyParsed={(parsed) => {
            setItems(parsed.items || []);
            if (parsed.taxes && parsed.taxes.length > 0) setTaxes(parsed.taxes);
            if (parsed.serviceCharge !== undefined) setServiceCharge(parsed.serviceCharge || 0);
            if (parsed.discount !== undefined) setDiscount(parsed.discount || 0);
            if (parsed.roundoff !== undefined) setRoundoff(parsed.roundoff || 0);
            if (parsed.total) setTotal(parsed.total);
          }}
        />
      )}
    </div>
  );
}

// ===== RAW OCR MODAL =====
function RawOCRModal({ initialText, onClose, onApplyParsed }) {
  const [text, setText] = useState(initialText || '');
  const toast = useToast();

  const handleParse = () => {
    try {
      const parsed = parseReceipt(text);
      if (parsed.items && parsed.items.length > 0) {
        sessionStorage.setItem('ocrResult', JSON.stringify({ text }));
        sessionStorage.setItem('parsedReceipt', JSON.stringify(parsed));
        onApplyParsed(parsed);
        toast(`Parsed ${parsed.items.length} items!`, 'success');
        onClose();
      } else {
        toast('No items detected. Ensure lines follow: Item Name ... Price', 'warning');
      }
    } catch (err) {
      toast('Parse error: ' + err.message, 'error');
    }
  };

  return (
    <div className="modal-backdrop animate-fadeIn" onClick={onClose} style={{ zIndex: 9999 }}>
      <div className="modal glass-card" style={{ maxWidth: 640, width: '92%' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontWeight: 700 }}>📜 Raw OCR Text &amp; Quick Fix</h3>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: '0.82rem', color: 'var(--ink-muted)', marginBottom: 12 }}>
          View, edit, or paste OCR text directly. If the scanner missed any items due to camera lighting, you can fix them here and click <strong>&ldquo;Parse Items&rdquo;</strong>.
        </p>
        <textarea
          className="input input-mono"
          rows={14}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Paste or edit receipt text here... e.g.&#10;1 MASALA COKE 200.00&#10;1 Tz's ELIXIR 200.00&#10;Gross Amount 3275.00"
          style={{ width: '100%', fontSize: '0.85rem', lineHeight: 1.5, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleParse}>⚡ Parse Items</button>
        </div>
      </div>
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
  const { addExpense } = useExpenses(groupId);

  useEffect(() => {
    const resolveGroup = async () => {
      let g = await dbOps.getGroup(groupId);
      if (!g) {
        const all = await dbOps.getAllGroups();
        if (all.length > 0) {
          g = all.find(x => x.id === groupId) || all[0];
        } else {
          g = {
            id: groupId || 'jugadu-cafe',
            name: 'Jugadu Cafe',
            members: [
              { id: 'm1', name: 'You' },
              { id: 'm2', name: 'Jerry' },
              { id: 'm3', name: 'Danny' },
              { id: 'm4', name: 'Richard' },
            ],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await dbOps.saveGroup(g);
        }
      }
      setGroup(g);
      setPayer(g.members[0]?.id || '');
      setParticipants(g.members.map(m => m.id));
    };

    resolveGroup().catch(console.error);
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
            <input className="input input-mono" type="text" inputMode="decimal" placeholder="0.00"
              value={amount}
              onFocus={e => e.target.select()}
              onChange={e => {
                const val = e.target.value.replace(/[^0-9.]/g, '');
                const parts = val.split('.');
                const clean = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : val;
                setAmount(clean);
              }} />
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
