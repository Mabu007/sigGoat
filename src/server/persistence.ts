/**
 * THE ONE PERSISTENCE INSTANCE
 * ============================
 * The datastore is shared by every route.
 *
 * It has to be ONE instance. The file-backed and in-memory modes keep
 * their state in the object AND write it to disk, so a second instance
 * would hold a different copy of the same data and the two would diverge
 * the moment either of them wrote.
 *
 * The room API and the legacy API both read the same rooms, the same
 * conversations and the same messages, so they must share this.
 */

import { createPersistence, type PersistenceLayer } from './repositories';

export const persistence: PersistenceLayer = createPersistence();
