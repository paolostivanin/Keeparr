import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKeeparrMcpServer } from './server.mjs';

async function withMcpClient(keeparrClient, run) {
  const server = createKeeparrMcpServer(keeparrClient);
  const client = new Client({ name: 'keeparr-mcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client); } finally { await Promise.all([client.close(), server.close()]); }
}

function stubKeeparrClient(overrides = {}) {
  return {
    searchNotes: async () => [], getNote: async noteId => ({ id: noteId, ownerUserId: 1, noteTitle: 'Note', checkBoxes: [], images: [] }),
    requestLockedNoteAccess: async noteId => ({ unlocked: false, unlockUrl: `https://keeparr.test/unlock/${noteId}` }),
    listLabels: async () => [], resolveLabels: async names => names.map((name, index) => ({ id: index + 1, name, added: true })),
    createNote: async note => ({ id: 11, ...note }), updateNote: async (noteId, changes) => ({ id: noteId, ...changes }),
    assertNoteOwner: async () => undefined, setLifecycle: async (noteId, state) => ({ ok: true, noteId, state }),
    permanentlyDeleteNote: async noteId => ({ ok: true, noteId }), listReminders: async () => [],
    createReminder: async reminder => ({ id: 1, ...reminder }), updateReminder: async (id, changes) => ({ id, ...changes }),
    deleteReminder: async reminderId => ({ ok: true, reminderId }), searchUsers: async () => [],
    setCollaborators: async (noteId, userIds) => ({ noteId, userIds }), uploadAttachment: async () => ({ id: 4 }),
    uploadImage: async file => ({ url: '/api/uploads/images/test.png', name: file.filename }),
    fileParamToUpload: async (file, { kind }) => ({ filename: file.file_name || kind, mimeType: file.mime_type, base64Data: Buffer.from('file').toString('base64') }),
    readImage: async () => ({ contentType: 'image/png', base64Data: Buffer.from('png').toString('base64') }),
    readAttachment: async () => ({ contentType: 'text/plain', base64Data: Buffer.from('hello').toString('base64') }),
    deleteAttachment: async (noteId, attachmentId) => ({ ok: true, noteId, attachmentId }), ...overrides
  };
}

const expectedTools = [
  'keeparr_add_image', 'keeparr_archive_note', 'keeparr_create_note', 'keeparr_delete_attachment', 'keeparr_delete_image', 'keeparr_delete_reminder',
  'keeparr_get_note', 'keeparr_list_labels', 'keeparr_list_reminders', 'keeparr_manage_checklist', 'keeparr_permanently_delete_note',
  'keeparr_read_attachment', 'keeparr_read_image', 'keeparr_request_locked_note_access', 'keeparr_restore_note', 'keeparr_search_notes', 'keeparr_search_users',
  'keeparr_set_collaborators', 'keeparr_set_reminder', 'keeparr_trash_note', 'keeparr_update_note', 'keeparr_update_reminder',
  'keeparr_upload_attachment'
].sort();

test('server advertises the complete Keeparr tool set and safety annotations', async () => {
  await withMcpClient(stubKeeparrClient(), async client => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
    assert.equal(tools.find(tool => tool.name === 'keeparr_search_notes').annotations.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === 'keeparr_permanently_delete_note').annotations.destructiveHint, true);
  });
});

test('create maps rich fields, sanitizes HTML, and resolves labels', async () => {
  let received;
  await withMcpClient(stubKeeparrClient({ createNote: async note => { received = note; return { id: 12, ...note }; } }), async client => {
    const result = await client.callTool({ name: 'keeparr_create_note', arguments: {
      title: '<b>Agent</b>', body: '<p>Hello</p><script>alert(1)</script><a href="javascript:bad()">bad</a>', format: 'html',
      binder: 'Automation', labels: ['agent'], pinned: true
    } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.result.id, 12);
  });
  assert.equal(received.noteTitle, 'Agent');
  assert.match(received.noteBody, /<p>Hello<\/p>/);
  assert.doesNotMatch(received.noteBody, /script|javascript/i);
  assert.deepEqual(received.labels, [{ id: 1, name: 'agent', added: true }]);
});

test('plain text is escaped rather than interpreted as HTML', async () => {
  let received;
  await withMcpClient(stubKeeparrClient({ createNote: async note => { received = note; return note; } }), async client => {
    await client.callTool({ name: 'keeparr_create_note', arguments: { body: '<b>literal</b>\nnext' } });
  });
  assert.equal(received.noteBody, '&lt;b&gt;literal&lt;/b&gt;<br>next');
});

test('checklist operations preserve existing items and update one item', async () => {
  let changes;
  await withMcpClient(stubKeeparrClient({
    getNote: async () => ({ id: 3, checkBoxes: [{ id: 10, data: 'Old', done: false, indentLevel: 0 }] }),
    updateNote: async (_id, next) => { changes = next; return next; }
  }), async client => {
    const result = await client.callTool({ name: 'keeparr_manage_checklist', arguments: { noteId: 3, action: 'update', itemId: 10, text: 'New', done: true } });
    assert.equal(result.isError, undefined);
  });
  assert.deepEqual(changes.checkBoxes, [{ id: 10, data: 'New', done: true, indentLevel: 0 }]);
  assert.equal(changes.isCbox, true);
});

test('owner-only organization fields are checked before update', async () => {
  let ownerChecks = 0;
  let updates = 0;
  await withMcpClient(stubKeeparrClient({
    assertNoteOwner: async () => { ownerChecks += 1; throw new Error('Only the note owner can change organization.'); },
    updateNote: async () => { updates += 1; }
  }), async client => {
    const result = await client.callTool({ name: 'keeparr_update_note', arguments: { noteId: 3, binder: 'Private' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Only the note owner/);
  });
  assert.equal(ownerChecks, 1);
  assert.equal(updates, 0);
});

test('locked checklist content is not overwritten before browser unlock', async () => {
  await withMcpClient(stubKeeparrClient({ getNote: async () => ({ id: 3, locked: true, lockedContentAvailable: false }) }), async client => {
    const result = await client.callTool({ name: 'keeparr_manage_checklist', arguments: { noteId: 3, action: 'add', text: 'Nope' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unlock this note/);
  });
});

test('attachment reads return an embedded binary resource', async () => {
  await withMcpClient(stubKeeparrClient(), async client => {
    const result = await client.callTool({ name: 'keeparr_read_attachment', arguments: { attachmentId: 4 } });
    assert.equal(result.content[0].type, 'resource');
    assert.equal(result.content[0].resource.mimeType, 'text/plain');
    assert.equal(Buffer.from(result.content[0].resource.blob, 'base64').toString(), 'hello');
  });
});

test('image and attachment tools accept ChatGPT file params', async () => {
  const uploaded = [];
  await withMcpClient(stubKeeparrClient({
    uploadImage: async file => {
      uploaded.push({ type: 'image', ...file });
      return { url: '/api/uploads/images/photo.png', name: file.filename };
    },
    uploadAttachment: async (noteId, file) => {
      uploaded.push({ type: 'attachment', noteId, ...file });
      return { id: 9, noteId, originalName: file.filename };
    }
  }), async client => {
    const image = await client.callTool({ name: 'keeparr_add_image', arguments: {
      noteId: 3,
      file: { download_url: 'https://files.example/photo.png', file_id: 'file_1', mime_type: 'image/png', file_name: 'photo.png' }
    } });
    const attachment = await client.callTool({ name: 'keeparr_upload_attachment', arguments: {
      noteId: 3,
      file: { download_url: 'https://files.example/report.pdf', file_id: 'file_2', mime_type: 'application/pdf', file_name: 'report.pdf' }
    } });
    assert.equal(image.isError, undefined);
    assert.equal(attachment.isError, undefined);
  });
  assert.equal(uploaded[0].type, 'image');
  assert.equal(uploaded[0].filename, 'photo.png');
  assert.equal(uploaded[1].type, 'attachment');
  assert.equal(uploaded[1].filename, 'report.pdf');
});

test('delete image removes one image by id and preserves the rest', async () => {
  let changes;
  await withMcpClient(stubKeeparrClient({
    getNote: async () => ({
      id: 3,
      images: [
        { id: 'keep', dataUrl: '/api/uploads/images/keep.png' },
        { id: 'remove-me', dataUrl: '/api/uploads/images/remove.png' }
      ]
    }),
    updateNote: async (_id, next) => { changes = next; return next; }
  }), async client => {
    const result = await client.callTool({ name: 'keeparr_delete_image', arguments: { noteId: 3, imageId: 'remove-me' } });
    assert.equal(result.isError, undefined);
  });
  assert.deepEqual(changes.images, [{ id: 'keep', dataUrl: '/api/uploads/images/keep.png' }]);
});

test('delete image requires an existing image and unlocked content', async () => {
  await withMcpClient(stubKeeparrClient({ getNote: async () => ({ id: 3, images: [{ id: 'one' }] }) }), async client => {
    const result = await client.callTool({ name: 'keeparr_delete_image', arguments: { noteId: 3, imageId: 'missing' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Image not found/);
  });
  await withMcpClient(stubKeeparrClient({ getNote: async () => ({ id: 3, locked: true, lockedContentAvailable: false, images: [{ id: 'one' }] }) }), async client => {
    const result = await client.callTool({ name: 'keeparr_delete_image', arguments: { noteId: 3, imageId: 'one' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unlock this note/);
  });
});

test('API failures become MCP tool errors without stopping the server', async () => {
  await withMcpClient(stubKeeparrClient({ getNote: async () => { throw new Error('Note not found.'); } }), async client => {
    const failed = await client.callTool({ name: 'keeparr_get_note', arguments: { noteId: 404 } });
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0].text, 'Note not found.');
    assert.equal((await client.callTool({ name: 'keeparr_list_labels', arguments: {} })).isError, undefined);
  });
});
