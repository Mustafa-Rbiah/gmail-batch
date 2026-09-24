import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createGmailClient,
  openGmailAllMail,
} from '../src/server/imap.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const { email, appPassword } = req.body || {};

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  const client = createGmailClient({ email, appPassword });

  try {
    await client.connect();
    const { lock } = await openGmailAllMail(client);

    try {
      const searchResult = await client.search({ gmraw: 'label:Downloaded' }, { uid: true });
      const uids = Array.isArray(searchResult) ? (searchResult as number[]) : [];

      if (uids.length === 0) {
        return res.json({
          success: true,
          count: 0,
          message: 'No emails were tagged with "Downloaded" label.',
        });
      }

      await client.messageFlagsRemove(uids, ['Downloaded'], { uid: true });

      return res.json({
        success: true,
        count: uids.length,
        message: `Successfully removed "Downloaded" label from ${uids.length} email(s).`,
      });
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (err: any) {
    console.error('Reset error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to remove "Downloaded" labels on Gmail.',
    });
  }
}
