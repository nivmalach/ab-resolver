// AB Testing Client Script
(function() {
  // Hide page immediately
  document.documentElement.classList.add('ab-hide');
  document.head.appendChild(
    Object.assign(document.createElement('style'), {
      textContent: 'html.ab-hide{opacity:0!important}html:not(.ab-hide){opacity:1!important;transition:opacity .1s}'
    })
  );

  // Get existing variant from cookie
  function getExperimentCookie() {
    const expCookie = document.cookie.split(';')
      .find(c => c.trim().startsWith('expvar_'));
    
    if (expCookie) {
      const [name, variant] = expCookie.trim().split('=');
      return {
        id: name.replace('expvar_', ''),
        variant
      };
    }
    return null;
  }

  // Check experiment and handle redirect
  fetch('https://ab-resolver.onrender.com/exp/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      url: location.href,
      variant: (getExperimentCookie() || {}).variant
    })
  })
  .then(response => response.json())
  .then(exp => {
    if (exp.active) {
      // Set cookie
      const expires = new Date(Date.now() + 90*24*60*60*1000).toUTCString();
      document.cookie = `expvar_${exp.id}=${exp.variant}; Path=/; Expires=${expires}; SameSite=Lax`;
      
      // Check if redirect needed
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
      
      // Push to dataLayer
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({
        event: 'exp_exposure',
        experiment_id: exp.id,
        variant_id: exp.variant
      });
    }
    document.documentElement.classList.remove('ab-hide');
  })
  .catch(() => document.documentElement.classList.remove('ab-hide'));
})();