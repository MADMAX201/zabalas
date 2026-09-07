// Interacciones sin dependencias
(function () {
  // Mostrar campo de acompañantes solo si "Sí, voy"
  const rsvp = document.getElementById('rsvpForm');
  if (rsvp) {
    const box = document.getElementById('guestsBox');
    rsvp.querySelectorAll('input[name=status]').forEach(r => r.addEventListener('change', () => { box.hidden = r.value !== 'yes' || !r.checked; }));
  }

  // Tienda: líneas de pedido
  const form = document.getElementById('orderForm');
  if (form) {
    const tpl = document.getElementById('lineTpl');
    const totalEl = document.getElementById('orderTotal');
    const btn = document.getElementById('orderBtn');
    const fmt = n => '$' + Number(n).toLocaleString('es-CO');

    function recalc() {
      let total = 0, lines = 0;
      form.querySelectorAll('.product').forEach(p => {
        const price = Number(p.dataset.price);
        p.querySelectorAll('.line-item').forEach(li => { total += price * (Number(li.querySelector('[name=item_qty]').value) || 0); lines++; });
      });
      totalEl.textContent = fmt(total);
      btn.disabled = !lines || total <= 0;
    }

    function addLine(p, pre) {
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.querySelector('[name=item_product]').value = p.dataset.product;
      const sizes = p.dataset.sizes ? p.dataset.sizes.split(',') : [];
      const sel = li.querySelector('select');
      if (sizes.length) {
        sel.innerHTML = '<option value="">Talla…</option>' + sizes.map(s => `<option>${s}</option>`).join('');
        sel.required = true;
        if (pre && pre.size) sel.value = pre.size;
      } else {
        li.querySelector('.sizeBox').style.display = 'none';
        sel.innerHTML = '<option value=""></option>';
      }
      if (pre) { li.querySelector('[name=item_qty]').value = pre.qty || 1; li.querySelector('[name=item_for]').value = pre.for_name || ''; }
      li.querySelector('.rm').addEventListener('click', () => { li.remove(); recalc(); });
      li.querySelector('[name=item_qty]').addEventListener('input', recalc);
      p.querySelector('.lines').appendChild(li);
      recalc();
      return { li, sel, sizes };
    }

    form.querySelectorAll('.add-line').forEach(b => b.addEventListener('click', () => {
      const { li, sel, sizes } = addLine(b.closest('.product'));
      (sizes.length ? sel : li.querySelector('[name=item_for]')).focus();
    }));

    // Precarga (edición de pedido)
    try {
      const pre = JSON.parse(form.dataset.prefill || '[]');
      pre.forEach(it => { const p = form.querySelector(`.product[data-product="${it.product_id}"]`); if (p && p.querySelector('.lines')) addLine(p, it); });
    } catch {}
    recalc();
  }

  // Copiar número Nequi
  document.querySelectorAll('.copy').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = '¡Copiado!'; setTimeout(() => b.textContent = 'Copiar', 1500); } catch {}
  }));

  // Vista previa de imagen al subir
  document.querySelectorAll('input[type=file][data-preview]').forEach(inp => inp.addEventListener('change', () => {
    const img = document.getElementById(inp.dataset.preview); const f = inp.files[0];
    if (img && f && f.type.startsWith('image/')) { img.src = URL.createObjectURL(f); img.hidden = false; }
  }));

  // Confirmaciones
  document.querySelectorAll('form[data-confirm]').forEach(f => f.addEventListener('submit', e => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));
})();
