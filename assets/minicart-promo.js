/** Minicart offer presentation. Horizon remains the cart state owner. */
(function () {
  if (window.__minicartOffersController) return;
  window.__minicartOffersController = true;

  let cartRequest = null;
  let refreshTimer = null;
  let drawerObserver = null;
  let lastCart = null;
  let refreshQueued = false;

  function normalizeFit(value) {
    const fit = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    if (!fit) return '';
    if (fit.includes('universal')) return 'universal';
    if (fit.includes('38/40/41/42') || fit === 'small') return 'small';
    if (fit.includes('44/45/46/49') || fit === 'large') return 'large';
    return fit;
  }

  function cartFit(cart) {
    if (!cart?.items?.length) return '';
    let universal = '';
    for (const item of cart.items) {
      for (const option of item.options_with_values || []) {
        if (String(option.name).toLowerCase() !== 'bandwidth') continue;
        const fit = normalizeFit(option.value);
        if (fit && fit !== 'universal') return fit;
        if (fit === 'universal') universal = fit;
      }
    }
    return universal;
  }

  function eligibleQuantity(cart, promo) {
    if (!cart) return 0;
    if (promo.dataset.countScope === 'all') return Number(cart.item_count ?? cart.itemCount ?? 0);
    const ids = new Set(String(promo.dataset.promoProductIds || '').split(',').map(Number).filter(Number.isFinite));
    return (cart.items || []).reduce(
      (quantity, item) => quantity + (ids.has(Number(item.product_id)) ? Number(item.quantity || 0) : 0), 0
    );
  }

  const formatMessage = (template, remaining) => String(template || '').replaceAll('[remaining]', String(remaining));

  function updatePromo(promo, cart) {
    const first = Number(promo.dataset.tier1Qty || 0);
    const final = Number(promo.dataset.tier2Qty || 0);
    if (!first || !final || final < first) return;
    const quantity = eligibleQuantity(cart, promo);
    let copy;
    if (quantity < first) copy = formatMessage(promo.dataset.msgBeforeFirst, first - quantity);
    else if (quantity === first && promo.dataset.msgExactTier1) copy = promo.dataset.msgExactTier1;
    else if (quantity < final) copy = formatMessage(promo.dataset.msgAfterFirst, final - quantity);
    else copy = promo.dataset.msgAfterSecond || '';

    const fill = promo.querySelector('[data-minicart-promo-fill]');
    const progress = promo.querySelector('[data-minicart-promo-progress]');
    const firstMarker = promo.querySelector('[data-minicart-promo-marker1]');
    const finalMarker = promo.querySelector('[data-minicart-promo-marker2]');
    promo.querySelector('[data-minicart-promo-message]')?.replaceChildren(document.createTextNode(copy));
    if (fill) fill.style.width = `${Math.min(quantity / final, 1) * 100}%`;
    if (progress) {
      progress.setAttribute('aria-valuenow', String(Math.min(quantity, final)));
      progress.setAttribute('aria-valuetext', copy);
    }
    if (firstMarker) {
      firstMarker.style.left = `${(first / final) * 100}%`;
      firstMarker.classList.toggle('is-active', quantity >= first);
    }
    if (finalMarker) {
      finalMarker.style.left = '100%';
      finalMarker.classList.toggle('is-active', quantity >= final);
    }
    promo.classList.toggle('is-complete', quantity >= final);
  }

  function updateUpsells(cart) {
    const wrapper = document.querySelector('#miniCartUpsellVariant');
    if (!wrapper) return;
    const fit = cartFit(cart);
    const variantIds = new Set((cart?.items || []).map((item) => Number(item.variant_id)));
    const productIds = new Set((cart?.items || []).map((item) => Number(item.product_id)));
    const hideProduct = wrapper.dataset.hideExistingProduct === 'true';
    const limit = Math.max(1, Number(wrapper.dataset.maxVisible || 6));
    let visible = 0;

    wrapper.querySelectorAll('.miniCartUpsellItem--variant').forEach((card) => {
      const requiredFit = normalizeFit(card.dataset.fit || card.dataset.requiredBandwidth);
      const fitMode = card.dataset.fitMode || 'match';
      let show = !variantIds.has(Number(card.dataset.variant));
      if (show && hideProduct) show = !productIds.has(Number(card.dataset.product));
      if (show && fitMode === 'match' && requiredFit && requiredFit !== 'universal') {
        show = Boolean(fit) && (fit === requiredFit || fit === 'universal');
      } else if (show && fitMode === 'universal') show = requiredFit === 'universal';
      if (show && visible >= limit) show = false;
      card.classList.toggle('active', show);
      card.hidden = !show;
      if (show) visible += 1;
    });

    wrapper.classList.toggle('active', visible > 0);
    wrapper.hidden = visible === 0;
    const title = wrapper.querySelector('#miniCartUpsellVariantTitle');
    title?.classList.toggle('active', visible > 0);
  }

  function apply(cart) {
    if (!cart) return;
    lastCart = cart;
    document.querySelectorAll('[data-minicart-promo]').forEach((promo) => updatePromo(promo, cart));
    updateUpsells(cart);
  }

  function fetchCart(force = false) {
    if (cartRequest) {
      if (force) refreshQueued = true;
      return cartRequest;
    }
    cartRequest = fetch(`${window.Shopify?.routes?.root || '/'}cart.js`, { headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) throw new Error('Unable to load cart');
        return response.json();
      })
      .then(apply)
      .catch((error) => console.warn('[MinicartOffers]', error.message))
      .finally(() => {
        cartRequest = null;
        if (refreshQueued) {
          refreshQueued = false;
          fetchCart();
        }
      });
    return cartRequest;
  }

  function scheduleFetch(delay = 80) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => fetchCart(true), delay);
  }

  function observeDrawer() {
    drawerObserver?.disconnect();
    const drawer = document.querySelector('cart-drawer-component');
    if (!drawer) return;
    drawerObserver = new MutationObserver((mutations) => {
      const hasAddedElement = mutations.some((mutation) =>
        Array.from(mutation.addedNodes).some((node) => node.nodeType === Node.ELEMENT_NODE)
      );
      if (lastCart && hasAddedElement) {
        requestAnimationFrame(() => apply(lastCart));
        scheduleFetch(30);
      }
    });
    drawerObserver.observe(drawer, { childList: true, subtree: true });
  }

  function init() {
    observeDrawer();
    fetchCart();
    document.addEventListener('cart:update', (event) => {
      const data = event?.detail?.data || event?.detail;
      const resource = event?.detail?.resource;
      const cart = data?.items ? data : resource?.items ? resource : null;
      if (cart) apply(cart);
      scheduleFetch(cart ? 180 : 30);
    });
    document.addEventListener('cart:refresh', () => scheduleFetch());
    document.addEventListener('shopify:section:load', () => {
      observeDrawer();
      if (lastCart) apply(lastCart);
      else fetchCart();
    });
    window.updateMiniCartPromo = (cart) => cart?.items ? apply(cart) : scheduleFetch(0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
