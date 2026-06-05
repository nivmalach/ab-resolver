// AB Testing Client Script
(function() {
  const script = document.currentScript;
  const resolverOrigin = script?.dataset?.resolverOrigin || new URL(script?.src || location.href, location.href).origin;
  const resolverUrl = `${resolverOrigin}/exp/resolve`;

  const style = document.createElement('style');
  style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
  document.head.appendChild(style);
  document.documentElement.classList.add('ab-hide');

  const urlParams = new URLSearchParams(location.search);
  const force = urlParams.get('__exp')?.replace('force', '');
  const clientId = getOrCreateCookie('ab_cid', createClientId(), 365);
  const previous = getPreviousAssignment();

  fetch(resolverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: location.href,
      cid: clientId,
      experiment_id: previous?.id,
      variant: previous?.variant,
      force: force === 'A' || force === 'B' ? force : undefined
    })
  })
  .then(response => response.json())
  .then(exp => {
    if (!exp.active) {
      revealPage();
      return;
    }

    const isForced = urlParams.get('__exp')?.startsWith('force');
    if (!isForced) {
      setCookie(`expvar_${exp.id}`, exp.variant, 90);
    }

    if (shouldRedirectToTest(exp)) {
      const test = new URL(exp.test_url);
      test.search = location.search || '';
      test.hash = location.hash || '';
      location.replace(test.toString());
      return;
    }

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'exp_exposure',
      experiment_id: exp.id,
      variant_id: exp.variant
    });
    revealPage();
  })
  .catch(revealPage);

  function shouldRedirectToTest(exp) {
    if (exp.variant !== 'B') return false;
    const current = location.pathname.replace(/\/$/, '') || '/';
    const baseline = new URL(exp.baseline_url).pathname.replace(/\/$/, '') || '/';
    const test = new URL(exp.test_url).pathname.replace(/\/$/, '') || '/';
    return current === baseline && current !== test;
  }

  function getPreviousAssignment() {
    const cookies = document.cookie.split(';').map(cookie => cookie.trim());
    for (const cookie of cookies) {
      if (!cookie.startsWith('expvar_')) continue;
      const index = cookie.indexOf('=');
      const id = cookie.slice('expvar_'.length, index);
      const variant = cookie.slice(index + 1);
      if (variant === 'A' || variant === 'B') return { id, variant };
    }
    return null;
  }

  function getOrCreateCookie(name, fallback, days) {
    const existing = getCookie(name);
    if (existing) return existing;
    setCookie(name, fallback, days);
    return fallback;
  }

  function getCookie(name) {
    const prefix = `${name}=`;
    const cookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
  }

  function setCookie(name, value, days) {
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Expires=${expires}; SameSite=Lax`;
  }

  function createClientId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function revealPage() {
    document.documentElement.classList.remove('ab-hide');
  }
})();
