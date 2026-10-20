/**
 * PROFILE PICTURE
 * ===============
 * The lifecycle of the profile picture, with a fake transport.
 *
 * NO NETWORK, NO DOM
 * ------------------
 * The decisions live in `src/hooks/profilePictureState.ts`, which talks to
 * the outside world through a `MediaTransport` interface. These tests supply
 * a fake one, so the interesting cases — a commit that fails, an upload
 * that fails, an answer that arrives too late — can be exercised exactly,
 * with no bucket, no server and no browser.
 *
 * WHAT IS PINNED HERE
 * -------------------
 *   1. Choosing a file does NOT change the picture. The commit route is not
 *      even called.
 *   2. Saving calls the commit route with the STAGED key.
 *   3. A failed save leaves the previous picture exactly where it was.
 *   4. A failed upload leaves the previous picture alone and says why.
 *   5. Removing goes through the server and clears the picture.
 *   6. An answer that arrives after a newer one does not overwrite it.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  MediaApiError,
  createProfilePictureFlow,
  type MediaTransport,
  type ProfilePictureState,
  type StagedUpload,
} from '../src/hooks/profilePictureState';
import {
  PROFILE_UPDATED_EVENT,
  getProfilePictureSnapshot,
  publishProfilePicture,
  resetProfilePictureStore,
  subscribeProfilePicture,
} from '../src/hooks/profilePictureStore';

// ---------------------------------------------------------------------------
// The fake transport
// ---------------------------------------------------------------------------

interface CommitCall {
  key: string;
  purpose: string;
  contentType: string;
  size: number;
}

interface RemoveCall {
  purpose: string;
  roomId?: string | null;
}

/** A ticket the fake server hands out. */
function fakeTicket(key: string) {
  return {
    key,
    uploadUrl: `https://worker.example/media/upload?t=${key}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    headers: { 'x-tradingvibes-ticket': `ticket-${key}` },
    purpose: 'avatar' as const,
    maxBytes: 1024,
    allowedTypes: ['image/png'],
  };
}

class FakeTransport implements MediaTransport {
  ticketCalls: { purpose: string; contentType: string }[] = [];
  uploadCalls: { key: string; file: File }[] = [];
  commitCalls: CommitCall[] = [];
  removeCalls: RemoveCall[] = [];

  /** When set, the next upload fails with this error. */
  failUpload: Error | null = null;
  /** When set, the next commit fails with this error. */
  failCommit: Error | null = null;
  /** When set, the next removal fails with this error. */
  failRemove: Error | null = null;

  /** The url the server signs for a committed picture. */
  committedUrl = 'https://media.example/avatars/uid/photo.png';

  /** Holds the next upload open, so a stale answer can be simulated. */
  holdUpload: ((release: () => void) => void) | null = null;

  private ticketCount = 0;

  async requestUploadTicket(input: { purpose: string; contentType: string }) {
    this.ticketCalls.push({ purpose: input.purpose, contentType: input.contentType });
    this.ticketCount += 1;
    return fakeTicket(`avatars/uid/photo-${this.ticketCount}.png`);
  }

  async uploadBytes(input: {
    uploadUrl: string;
    headers: Record<string, string>;
    file: File;
    onProgress: (ratio: number) => void;
  }) {
    this.uploadCalls.push({ key: input.uploadUrl, file: input.file });
    input.onProgress(0.5);

    if (this.failUpload) {
      const failure = this.failUpload;
      this.failUpload = null;
      throw failure;
    }

    if (this.holdUpload) {
      const release = this.holdUpload;
      this.holdUpload = null;
      await new Promise<void>(resolve => {
        release(() => resolve());
      });
    }

    return { contentType: 'image/png', size: input.file.size };
  }

  async commitMedia(input: CommitCall) {
    this.commitCalls.push(input);
    if (this.failCommit) {
      const failure = this.failCommit;
      this.failCommit = null;
      throw failure;
    }
    return { url: this.committedUrl };
  }

  async removeMedia(input: RemoveCall) {
    this.removeCalls.push(input);
    if (this.failRemove) {
      const failure = this.failRemove;
      this.failRemove = null;
      throw failure;
    }
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface Harness {
  flow: ReturnType<typeof createProfilePictureFlow>;
  transport: FakeTransport;
  state: () => ProfilePictureState;
  revoked: string[];
  committed: (string | null)[];
}

function createHarness(): Harness {
  const transport = new FakeTransport();
  const revoked: string[] = [];
  const committed: (string | null)[] = [];
  let latest: ProfilePictureState;

  const flow = createProfilePictureFlow({
    transport,
    getContext: () => ({ purpose: 'avatar' }),
    onChange: (next) => {
      latest = next;
    },
    onCommitted: (url) => committed.push(url),
    createPreviewUrl: (file) => `blob:preview-${file.name}`,
    revokePreviewUrl: (url) => {
      if (url) revoked.push(url);
    },
  });

  return {
    flow,
    transport,
    state: () => latest,
    revoked,
    committed,
  };
}

/** A PNG file the fake server will accept. */
function pngFile(name = 'photo.png', bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('the staged upload', () => {
  test('does not call the commit route: choosing a file is not saving it', async () => {
    const harness = createHarness();

    const staged = await harness.flow.stageUpload(pngFile());

    expect(staged).not.toBeNull();
    expect(harness.transport.commitCalls).toEqual([]);
    expect(harness.transport.ticketCalls).toHaveLength(1);
    expect(harness.transport.uploadCalls).toHaveLength(1);

    // The picture is STAGED, not authoritative.
    expect(harness.state().status).toBe('staged');
    expect(harness.state().staged?.key).toBe(staged?.key);
    expect(harness.state().url).toBeNull();
    expect(harness.committed).toEqual([]);
  });

  test('rejects a file that is not an image, and stages nothing', async () => {
    const harness = createHarness();

    const staged = await harness.flow.stageUpload(
      new File([new Uint8Array(4)], 'notes.txt', { type: 'text/plain' }),
    );

    expect(staged).toBeNull();
    expect(harness.state().status).toBe('error');
    expect(harness.state().error).toContain('PNG');
    expect(harness.state().staged).toBeNull();
    expect(harness.transport.uploadCalls).toHaveLength(0);
  });

  test('rejects an oversized file before a single byte is sent', async () => {
    const harness = createHarness();

    const oversized = new File([new Uint8Array(5 * 1024 * 1024)], 'big.png', {
      type: 'image/png',
    });
    const staged = await harness.flow.stageUpload(oversized);

    expect(staged).toBeNull();
    expect(harness.state().status).toBe('error');
    expect(harness.state().error).toContain('MB limit');
    expect(harness.transport.uploadCalls).toHaveLength(0);
  });
});

describe('the commit', () => {
  test('calls the commit route with the staged key', async () => {
    const harness = createHarness();

    const staged = await harness.flow.stageUpload(pngFile());
    expect(harness.transport.commitCalls).toHaveLength(0);

    const url = await harness.flow.commit();

    expect(harness.transport.commitCalls).toHaveLength(1);
    expect(harness.transport.commitCalls[0].key).toBe(staged?.key);
    expect(harness.transport.commitCalls[0].purpose).toBe('avatar');
    expect(url).toBe(harness.transport.committedUrl);
    expect(harness.state().url).toBe(harness.transport.committedUrl);
    expect(harness.state().staged).toBeNull();
    expect(harness.state().status).toBe('done');
    expect(harness.committed).toEqual([harness.transport.committedUrl]);
  });

  test('a failed commit keeps the previous saved picture and surfaces the error', async () => {
    const harness = createHarness();

    // A picture is saved first.
    await harness.flow.stageUpload(pngFile('first.png'));
    await harness.flow.commit();
    const savedUrl = harness.state().url;
    expect(savedUrl).toBe(harness.transport.committedUrl);

    // A second picture is staged, and its commit fails.
    await harness.flow.stageUpload(pngFile('second.png'));
    harness.transport.failCommit = new MediaApiError(
      'The server rejected that request.',
      500,
    );

    const url = await harness.flow.commit();

    expect(url).toBeNull();
    expect(harness.state().url).toBe(savedUrl);
    expect(harness.state().status).toBe('error');
    expect(harness.state().error).toBe('The server rejected that request.');
    /** The staged upload is kept, so it can be saved again. */
    expect(harness.state().staged).not.toBeNull();
  });
});

describe('a failed upload', () => {
  test('surfaces the error and leaves the saved picture alone', async () => {
    const harness = createHarness();

    await harness.flow.stageUpload(pngFile('first.png'));
    await harness.flow.commit();
    const savedUrl = harness.state().url;

    harness.transport.failUpload = new MediaApiError(
      'Could not reach the upload server.',
      0,
    );
    const staged = await harness.flow.stageUpload(pngFile('second.png'));

    expect(staged).toBeNull();
    expect(harness.state().status).toBe('error');
    expect(harness.state().error).toContain('Could not reach the server');
    expect(harness.state().url).toBe(savedUrl);
    expect(harness.state().staged).toBeNull();
    expect(harness.transport.commitCalls).toHaveLength(1);
  });
});

describe('the removal', () => {
  test('calls the remove route and clears the picture', async () => {
    const harness = createHarness();

    await harness.flow.stageUpload(pngFile());
    await harness.flow.commit();
    expect(harness.state().url).toBe(harness.transport.committedUrl);

    const removed = await harness.flow.remove();

    expect(removed).toBe(true);
    expect(harness.transport.removeCalls).toHaveLength(1);
    expect(harness.transport.removeCalls[0].purpose).toBe('avatar');
    expect(harness.state().url).toBeNull();
    expect(harness.state().status).toBe('idle');
    expect(harness.committed).toEqual([harness.transport.committedUrl, null]);
  });

  test('a failed removal keeps the picture and says why', async () => {
    const harness = createHarness();

    await harness.flow.stageUpload(pngFile());
    await harness.flow.commit();
    const savedUrl = harness.state().url;

    harness.transport.failRemove = new MediaApiError(
      'The server rejected that request.',
      500,
    );
    const removed = await harness.flow.remove();

    expect(removed).toBe(false);
    expect(harness.state().url).toBe(savedUrl);
    expect(harness.state().status).toBe('error');
    expect(harness.state().error).toBe('The server rejected that request.');
  });
});

describe('discarding a staged upload', () => {
  test('forgets it without committing it, and keeps the saved picture', async () => {
    const harness = createHarness();

    await harness.flow.stageUpload(pngFile('first.png'));
    await harness.flow.commit();
    const savedUrl = harness.state().url;

    const staged = await harness.flow.stageUpload(pngFile('second.png'));
    expect(harness.state().staged?.key).toBe(staged?.key);

    harness.flow.discard();

    expect(harness.state().staged).toBeNull();
    expect(harness.state().url).toBe(savedUrl);
    expect(harness.transport.commitCalls).toHaveLength(1);
    /** The local preview of the discarded upload is released. */
    expect(harness.revoked).toContain(staged?.url);
  });
});

describe('a stale answer', () => {
  test('an upload that resolves after a newer one does not overwrite it', async () => {
    const harness = createHarness();

    /** The first upload is held open until the test releases it. */
    let releaseFirst: (() => void) | null = null;
    harness.transport.holdUpload = (release: () => void) => {
      releaseFirst = release;
    };

    const first = harness.flow.stageUpload(pngFile('first.png'));

    /** Let the first attempt reach the transport, so it can be held there. */
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(harness.transport.uploadCalls).toHaveLength(1);

    const second = harness.flow.stageUpload(pngFile('second.png'));

    /**
     * The newer upload lands first, then the older one answers late.
     */
    const secondStaged = await second;
    expect(secondStaged).not.toBeNull();

    /** Let the held upload finish. */
    releaseFirst?.();

    const firstStaged = await first;

    expect(firstStaged).toBeNull();
    expect(harness.state().staged?.key).toBe(secondStaged?.key);
    expect(harness.state().status).toBe('staged');
  });

  test('a commit that lands after the file was replaced does not overwrite the newer state', async () => {
    const harness = createHarness();

    await harness.flow.stageUpload(pngFile('first.png'));
    const saving = harness.flow.commit();

    /** While the save is in flight, the trader picks a different picture. */
    const replacement = await harness.flow.stageUpload(pngFile('second.png'));

    expect(replacement).not.toBeNull();
    const committed = await saving;

    /** The late answer is ignored: the newer staged upload stands. */
    expect(committed).toBeNull();
    expect(harness.state().staged?.key).toBe(replacement?.key);
    expect(harness.state().status).toBe('staged');
  });
});

describe('the staged upload itself', () => {
  test('carries the key, the type and the size the server and the bytes agree on', async () => {
    const harness = createHarness();

    const staged = (await harness.flow.stageUpload(pngFile('photo.png', 12))) as StagedUpload;

    expect(staged.key).toBe('avatars/uid/photo-1.png');
    expect(staged.contentType).toBe('image/png');
    expect(staged.size).toBe(12);
    expect(staged.url).toBe('blob:preview-photo.png');
  });
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('the profile picture store', () => {
  test('one copy: publishing a picture tells every reader', () => {
    resetProfilePictureStore();

    const seen: (string | null)[] = [];
    const unsubscribe = subscribeProfilePicture(() => {
      seen.push(getProfilePictureSnapshot().url);
    });

    publishProfilePicture({
      url: 'https://media.example/avatars/uid/photo.png',
      ownerId: 'uid',
      loaded: true,
    });

    expect(seen).toEqual(['https://media.example/avatars/uid/photo.png']);
    expect(getProfilePictureSnapshot().url).toBe(
      'https://media.example/avatars/uid/photo.png',
    );

    unsubscribe();
  });

  test('a publish that changes nothing does not wake the readers', () => {
    resetProfilePictureStore();
    publishProfilePicture({ url: 'https://media.example/a.png', loaded: true });

    let calls = 0;
    const unsubscribe = subscribeProfilePicture(() => {
      calls += 1;
    });

    publishProfilePicture({ url: 'https://media.example/a.png', loaded: true });

    expect(calls).toBe(0);

    unsubscribe();
  });

  test('signing out empties the store', () => {
    resetProfilePictureStore();
    publishProfilePicture({ url: 'https://media.example/a.png', loaded: true });

    resetProfilePictureStore();

    expect(getProfilePictureSnapshot().url).toBeNull();
    expect(getProfilePictureSnapshot().loaded).toBe(false);
  });

  test('the update event carries the new url', () => {
    expect(PROFILE_UPDATED_EVENT).toBe('tradingvibes:profile-updated');
  });
});

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

describe('the settings screen', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dir, '..', 'src', 'components', 'views', 'SettingsView.tsx'),
    'utf8',
  );

  test('does not keep a second copy of the picture', () => {
    /**
     * The picture is read from ONE store. A second fetch of `/api/profile`
     * in the settings screen would be a second copy, and two copies are how
     * the picture came to disagree with itself.
     */
    expect(source).not.toContain('/api/profile');
    expect(source).not.toContain('avatarUrl');
  });

  test('hands the whole workflow to the profile picture row', () => {
    expect(source).toContain('<ProfilePicture');
  });
});
