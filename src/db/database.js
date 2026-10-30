import { openDB } from 'idb';

const DB_NAME = 'SplitSmartDB';
const DB_VERSION = 1;

let dbPromise = null;

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Groups store
        if (!db.objectStoreNames.contains('groups')) {
          const groupStore = db.createObjectStore('groups', { keyPath: 'id' });
          groupStore.createIndex('name', 'name');
          groupStore.createIndex('createdAt', 'createdAt');
        }

        // Expenses store
        if (!db.objectStoreNames.contains('expenses')) {
          const expenseStore = db.createObjectStore('expenses', { keyPath: 'id' });
          expenseStore.createIndex('groupId', 'groupId');
          expenseStore.createIndex('date', 'date');
          expenseStore.createIndex('createdAt', 'createdAt');
        }

        // Settlements store
        if (!db.objectStoreNames.contains('settlements')) {
          const settlementStore = db.createObjectStore('settlements', { keyPath: 'id' });
          settlementStore.createIndex('groupId', 'groupId');
          settlementStore.createIndex('settled', 'settled');
        }
      },
    });
  }
  return dbPromise;
}

// ===== UUID Generator =====
export function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : 
    'xxxx-xxxx-xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

// ===== GROUPS =====
export async function getAllGroups() {
  const db = await getDB();
  return db.getAll('groups');
}

export async function getGroup(id) {
  const db = await getDB();
  return db.get('groups', id);
}

export async function saveGroup(group) {
  const db = await getDB();
  group.updatedAt = Date.now();
  return db.put('groups', group);
}

export async function createGroup(name, members = []) {
  const group = {
    id: generateId(),
    name,
    members,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveGroup(group);
  return group;
}

export async function deleteGroup(id) {
  const db = await getDB();
  // Also delete related expenses and settlements
  const tx = db.transaction(['groups', 'expenses', 'settlements'], 'readwrite');
  
  // Delete all expenses for this group
  const expenseIndex = tx.objectStore('expenses').index('groupId');
  let cursor = await expenseIndex.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  
  // Delete all settlements for this group
  const settlementIndex = tx.objectStore('settlements').index('groupId');
  cursor = await settlementIndex.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  
  // Delete the group itself
  await tx.objectStore('groups').delete(id);
  await tx.done;
}

// ===== EXPENSES =====
export async function getExpensesByGroup(groupId) {
  const db = await getDB();
  return db.getAllFromIndex('expenses', 'groupId', groupId);
}

export async function getExpense(id) {
  const db = await getDB();
  return db.get('expenses', id);
}

export async function saveExpense(expense) {
  const db = await getDB();
  expense.updatedAt = Date.now();
  return db.put('expenses', expense);
}

export async function createExpense(expenseData) {
  const expense = {
    id: generateId(),
    ...expenseData,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await saveExpense(expense);
  return expense;
}

export async function deleteExpense(id) {
  const db = await getDB();
  return db.delete('expenses', id);
}

// ===== SETTLEMENTS =====
export async function getSettlementsByGroup(groupId) {
  const db = await getDB();
  return db.getAllFromIndex('settlements', 'groupId', groupId);
}

export async function saveSettlement(settlement) {
  const db = await getDB();
  settlement.updatedAt = Date.now();
  return db.put('settlements', settlement);
}

export async function markSettled(settlementId) {
  const db = await getDB();
  const settlement = await db.get('settlements', settlementId);
  if (settlement) {
    settlement.settled = true;
    settlement.settledAt = Date.now();
    await db.put('settlements', settlement);
  }
  return settlement;
}

export async function markUnsettled(settlementId) {
  const db = await getDB();
  const settlement = await db.get('settlements', settlementId);
  if (settlement) {
    settlement.settled = false;
    settlement.settledAt = null;
    await db.put('settlements', settlement);
  }
  return settlement;
}

export async function saveSettlements(groupId, transactions) {
  const db = await getDB();
  const tx = db.transaction('settlements', 'readwrite');
  
  // Clear old settlements for this group
  const index = tx.store.index('groupId');
  let cursor = await index.openCursor(groupId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  
  // Save new settlements
  for (const t of transactions) {
    await tx.store.put({
      id: t.id || generateId(),
      groupId,
      fromId: t.from || t.fromId,
      toId: t.to || t.toId,
      amountPaise: t.amountPaise,
      settled: Boolean(t.settled),
      settledAt: t.settled ? (t.settledAt || Date.now()) : null,
      createdAt: t.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
  }
  
  await tx.done;
}

// ===== EXPORT / IMPORT =====
export async function exportGroupData(groupId) {
  const group = await getGroup(groupId);
  const expenses = await getExpensesByGroup(groupId);
  const settlements = await getSettlementsByGroup(groupId);
  return { group, expenses, settlements, exportedAt: Date.now(), version: 1 };
}

export async function importGroupData(data) {
  if (!data.group || !data.expenses) {
    throw new Error('Invalid import data');
  }
  
  // Generate new IDs to avoid conflicts
  const oldToNewId = {};
  const newGroupId = generateId();
  oldToNewId[data.group.id] = newGroupId;
  
  // Update member IDs
  const newMembers = data.group.members.map(m => {
    const newId = generateId();
    oldToNewId[m.id] = newId;
    return { ...m, id: newId };
  });
  
  const group = {
    ...data.group,
    id: newGroupId,
    members: newMembers,
    name: data.group.name + ' (imported)',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  await saveGroup(group);
  
  // Import expenses
  for (const exp of data.expenses) {
    const newExpense = {
      ...exp,
      id: generateId(),
      groupId: newGroupId,
      payerId: oldToNewId[exp.payerId] || exp.payerId,
      items: exp.items?.map(item => ({
        ...item,
        id: generateId(),
        assignees: item.assignees?.map(a => oldToNewId[a] || a) || [],
      })) || [],
      splits: exp.splits ? Object.fromEntries(
        Object.entries(exp.splits).map(([k, v]) => [oldToNewId[k] || k, v])
      ) : {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await saveExpense(newExpense);
  }
  
  return group;
}
