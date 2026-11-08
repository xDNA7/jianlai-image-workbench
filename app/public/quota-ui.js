(() => {
  let remaining = null;
  const apply = () => {
    if (remaining == null) return;
    const balance = document.querySelector('#balance');
    if (balance) balance.textContent = `剩余额度 ${remaining} 张`;
    document.querySelectorAll('#generation-cost, .cost b').forEach((node) => {
      node.textContent = '';
      node.hidden = true;
    });
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = String(args[0]?.url || args[0] || '');
    if (url.includes('/api/bootstrap') || url.includes('/api/jobs/')) {
      try {
        const data = await response.clone().json();
        if (Number.isFinite(data.availableImages)) remaining = data.availableImages;
        apply();
      } catch {}
    }
    return response;
  };
  new MutationObserver(apply).observe(document.documentElement, {childList: true, subtree: true});
})();
