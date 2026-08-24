import { DialogComponent } from '@theme/dialog';
import { CartAddEvent } from '@theme/events';

const FREE_ITEM_PRODUCT_ID = 9023281955056;

/**
 * A custom element that manages a cart drawer.
 *
 * @extends {DialogComponent}
 */
class CartDrawerComponent extends DialogComponent {
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener(CartAddEvent.eventName, this.#handleCartAdd);

    // Handle upsell "Add" buttons inside the drawer (event delegation)
    this.addEventListener('click', this.#handleUpsellClick);
       // Evaluate checkout eligibility every time the drawer opens
    this.#updateCheckoutState();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(CartAddEvent.eventName, this.#handleCartAdd);
   // Evaluate checkout eligibility every time the drawer opens
    this.#updateCheckoutState();
    this.removeEventListener('click', this.#handleUpsellClick);
  }

  #handleCartAdd = () => {
    if (this.hasAttribute('auto-open')) {
      this.showDialog();
         // Evaluate checkout eligibility every time the drawer opens
    this.#updateCheckoutState();
    }
  };

  open() {
    this.showDialog();

   // Evaluate checkout eligibility every time the drawer opens
    this.#updateCheckoutState();

    /**
     * Close cart drawer when installments CTA is clicked to avoid overlapping dialogs
     */
    customElements.whenDefined('shopify-payment-terms').then(() => {
      const installmentsContent = document.querySelector('shopify-payment-terms')?.shadowRoot;
      const cta = installmentsContent?.querySelector('#shopify-installments-cta');
      cta?.addEventListener('click', this.closeDialog, { once: true });
    });
  }

  close() {
    this.closeDialog();
       // Evaluate checkout eligibility every time the drawer opens
    this.#updateCheckoutState();
  }

  /**
   * Click handler for upsell add buttons.
   */
  #handleUpsellClick = async (event) => {
    const btn = event.target?.closest?.('.miniCartUpsellItemBtn');
    if (!btn) return;

    event.preventDefault();

    const variantIdRaw = btn.dataset.variantId;
    const variantId = Number.parseInt(variantIdRaw, 10);

    if (!variantId || Number.isNaN(variantId)) return;

    btn.disabled = true;
    btn.classList.add('is-loading');

    try {
      const addResult = await this.#addVariantToCart(variantId, 1);

      // 1. Update the Drawer UI immediately
      if (addResult.sections) {
        this.#applySections(addResult.sections);
      } else {
        await this.#refreshDrawerSection();
      }

      // 2. CONSTRUCT PAYLOAD: Match the structure expected by component-cart-items.js
      const itemCount = addResult.itemCount ?? addResult.item_count;
      
      const payload = {
        data: {
          ...addResult,
          itemCount: itemCount,
          sections: addResult.sections,
          source: 'cart-drawer-upsell',
        }
      };

      // 3. DISPATCH: Trigger both the class event and the generic browser event
      // This ensures the Bubble, the Promo Bar, and the Cart Items all react.
      document.dispatchEvent(new CartAddEvent(payload.data, this.id));
      
      document.dispatchEvent(new CustomEvent('cart:update', {
        bubbles: true,
        detail: payload,
        
      }));

 

      // 4. MANUAL BUBBLE FALLBACK: Just in case the header section didn't morph
      this.#updateAllBubbles(itemCount);
         // Evaluate checkout eligibility every time the drawer opens
    this.#updateCheckoutState();

    } catch (err) {
      console.error('[CartDrawer] Failed to add upsell item:', err);
    } finally {
      btn.classList.remove('is-loading');
      btn.disabled = false;
    }
  };

  #addVariantToCart = async (variantId, quantity = 1) => {
    const drawerSectionIds = Array.from(this.querySelectorAll('cart-items-component'))
      .map((el) => el?.dataset?.sectionId)
      .filter(Boolean);

    // Get the header section ID to ensure the bubble HTML is returned
    const headerSection = document.querySelector('section-header, .section-header, [id*="header"]');
    const headerId = headerSection?.id?.replace('shopify-section-', '') || headerSection?.getAttribute('data-section-id');

    const uniqueSectionIds = [...new Set([...drawerSectionIds, headerId])].filter(Boolean);

    const formData = new FormData();
    formData.append('id', variantId);
    formData.append('quantity', quantity);
    uniqueSectionIds.forEach((id) => formData.append('sections', id));
    formData.append('sections_url', window.location.pathname);

    const res = await fetch(`${Shopify.routes.root}cart/add.js`, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.description || 'Add to cart failed');
    return data;
  };

  #applySections = (sections) => {
    if (!sections || typeof sections !== 'object') return;

    Object.entries(sections).forEach(([sectionId, html]) => {
      // Update global document, not just "this"
      const current = document.querySelector(`[data-section-id="${CSS.escape(sectionId)}"]`) 
                   || document.getElementById(`shopify-section-${sectionId}`);
      
      if (!current) return;

      const nextDoc = new DOMParser().parseFromString(html, 'text/html');
      
      // Update cart items specifically if they exist
      const nextCartItems = nextDoc.querySelector('cart-items-component');
      const currentCartItems = current.querySelector('cart-items-component') || (current.tagName === 'CART-ITEMS-COMPONENT' ? current : null);

      if (nextCartItems && currentCartItems) {
        currentCartItems.innerHTML = nextCartItems.innerHTML;
      } else {
        // Replace innerHTML for the header/bubble section
        current.innerHTML = nextDoc.body?.firstElementChild?.innerHTML || nextDoc.body?.innerHTML;
      }
    });
  };

  #updateAllBubbles = (count) => {
    if (count === undefined) return;
    const bubbles = document.querySelectorAll('.cart-bubble, .cart-count, [ref="cartItemCount"]');
    bubbles.forEach(bubble => {
      bubble.textContent = count;
      bubble.classList.toggle('hidden', count === 0);
    });
  };

  /**
   * Fetches the current cart and disables the checkout button if the only
   * item(s) in the cart are the free item (FREE_ITEM_PRODUCT_ID).
   */
  #updateCheckoutState = async () => {
    try {
      const res = await fetch(`${Shopify.routes.root}cart.js`);
      const cart = await res.json();

      const items = cart.items ?? [];
      const onlyFreeItem =
        items.length > 0 &&
        items.every((item) => item.product_id === FREE_ITEM_PRODUCT_ID);

      const checkoutBtns = this.querySelectorAll('[name="checkout"], .cart__checkout-button, a[href="/checkout"]');

      // Remove any existing warning message before re-evaluating
      this.querySelector('#free-item-checkout-warning')?.remove();

      if (onlyFreeItem) {
        checkoutBtns.forEach((btn) => {
          btn.disabled = true;
          btn.setAttribute('aria-disabled', 'true');
        });

        // Insert warning message after the first checkout button found
        const firstBtn = checkoutBtns[0];
        if (firstBtn) {
          const warning = document.createElement('p');
          warning.id = 'free-item-checkout-warning';
          warning.style.cssText = 'margin-top: 0.5rem; color: red; font-size: 0.875rem; text-align: center;';
          warning.textContent = 'You must have at least 1 paid item to checkout';
          firstBtn.insertAdjacentElement('afterend', warning);
        }
      } else {
        checkoutBtns.forEach((btn) => {
          btn.disabled = false;
          btn.removeAttribute('aria-disabled');
        });
      }
    } catch (err) {
      console.error('[CartDrawer] Failed to evaluate checkout state:', err);
    }
  };

  /**
   * Fallback refresh method if cart-items-component does not expose a refresh API.
   * Reloads the drawer section HTML and replaces the cart-items-component contents.
   */
  #refreshDrawerSection = async () => {
    const sectionId = this.querySelector('cart-items-component')?.dataset?.sectionId;
    if (!sectionId) {
      // If we can't refresh by section, last fallback: reload the page fragment via cart page
      // (Do nothing here to avoid unexpected behavior)
      return;
    }

    const res = await fetch(
      `${window.location.pathname}?sections=${encodeURIComponent(sectionId)}`,
      { headers: { Accept: 'application/json' } }
    );

    if (!res.ok) return;

    const json = await res.json();
    const html = json?.[sectionId];
    if (!html) return;

    const nextDoc = new DOMParser().parseFromString(html, 'text/html');
    const nextCartItems = nextDoc.querySelector('cart-items-component');
    const currentCartItems = this.querySelector('cart-items-component');

    if (nextCartItems && currentCartItems) {
      currentCartItems.innerHTML = nextCartItems.innerHTML;
    }
  };
}

if (!customElements.get('cart-drawer-component')) {
  customElements.define('cart-drawer-component', CartDrawerComponent);
}