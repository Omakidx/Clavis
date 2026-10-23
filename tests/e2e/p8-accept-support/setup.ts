import { send } from '../p3-support/background';
import { openExtensionPage } from '../p3-ui-support/pages';
import { ACCEPT_KEY, type World } from './world';

/** Store the fake key and acknowledge the data notice, as finished onboarding leaves them. */
export async function setUpKey(
  world: World,
  options: { acknowledged?: boolean } = {},
): Promise<void> {
  const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await send(page, { v: 1, type: 'SET_API_KEY', apiKey: ACCEPT_KEY, storage: 'local' });
  if (options.acknowledged !== false) await send(page, { v: 1, type: 'ACCEPT_DISCLOSURE' });
  await page.close();
  world.groq.reset();
  world.groqUrls.length = 0;
}
