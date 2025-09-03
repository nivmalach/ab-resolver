// AB Testing Client Script
(function() {
  // Add minimal styles inline to prevent FOUC
  const style = document.createElement('style');
  style.textContent = 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}';
  document.head.appendChild(style);
  document.documentElement.classList.add('ab-hide');

  // Get existing variant from cookie
  const expCookie = document.cookie.split(';')
    .find(c => c.trim().startsWith('expvar_'));
  
  const existingVariant = expCookie ? {
    id: expCookie.trim().split('=')[0].replace('expvar_', ''),
    variant: expCookie.trim().split('=')[1]
  } : null;

  // Get force parameter from URL
  const urlParams = new URLSearchParams(location.search);
  const force = urlParams.get('__exp')?.replace('force', '');

  // Single API call with existing variant and force parameter
  fetch('https://ab-resolver.opsotools.com/exp/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      url: location.href,
      variant: existingVariant?.variant,
      force: force === 'A' || force === 'B' ? force : undefined
    })
  })
  .then(response => response.json())
  .then(exp => {
    if (!exp.active) {
      document.documentElement.classList.remove('ab-hide');
      return;
    }

    // Set/update cookie only if not using force parameter
    const urlParams = new URLSearchParams(location.search);
    const isForced = urlParams.get('__exp')?.startsWith('force');
    
    if (!isForced) {
      const expires = new Date(Date.now() + 90*24*60*60*1000).toUTCString();
      document.cookie = `expvar_${exp.id}=${exp.variant}; Path=/; Expires=${expires}; SameSite=Lax`;
    }
    
    // Handle redirect if needed
    if (exp.variant === 'B') {
      const current = location.pathname.replace(/\/$/, '');
      const baseline = new URL(exp.baseline_url).pathname.replace(/\/$/, '');
      
      if (current === baseline) {
        const test = new URL(exp.test_url);
        test.search = location.search || '';
        test.hash = location.hash || '';
        location.replace(test.toString());
        return;
      }
    }
    
    // Push to dataLayer and unhide
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'exp_exposure',
      experiment_id: exp.id,
      variant_id: exp.variant
    });
    document.documentElement.classList.remove('ab-hide');
  })
  .catch(() => document.documentElement.classList.remove('ab-hide'));
})();