const PUBLIC_MEDIA_ROUTE = '/api/v1/media/public';

export function createPublicMediaUrl(storageKey: string): string {
  return `${PUBLIC_MEDIA_ROUTE}/${Buffer.from(storageKey, 'utf8').toString('base64url')}`;
}

export function migrateLegacyPublicMediaUrl(
  value: string,
  legacyBaseUrl?: string,
): string | null {
  if (!legacyBaseUrl) return null;

  try {
    const legacyBase = new URL(legacyBaseUrl);
    const candidate = new URL(value);
    const basePath = legacyBase.pathname.replace(/\/+$/, '');
    const keyPrefix = basePath ? `${basePath}/` : '/';

    if (
      candidate.origin !== legacyBase.origin ||
      !candidate.pathname.startsWith(keyPrefix)
    ) {
      return null;
    }

    const storageKey = decodeURIComponent(
      candidate.pathname.slice(keyPrefix.length),
    );
    return isAllowedPublicMediaKey(storageKey)
      ? createPublicMediaUrl(storageKey)
      : null;
  } catch {
    return null;
  }
}

export function parsePublicMediaToken(token: string): string | null {
  try {
    const storageKey = Buffer.from(token, 'base64url').toString('utf8');
    return isAllowedPublicMediaKey(storageKey) ? storageKey : null;
  } catch {
    return null;
  }
}

function isAllowedPublicMediaKey(storageKey: string): boolean {
  return /^(?:course-thumbnails|avatars|portfolio-images)\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(
    storageKey,
  );
}
