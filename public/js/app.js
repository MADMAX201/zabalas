// Interacciones sin dependencias
(function () {
  // Mostrar campo de acompañantes solo si "Sí, voy"
  const rsvp = document.getElementById('rsvpForm');
  if (rsvp) {
    const box = document.getElementById('guestsBox'), dbox = document.getElementById('datesBox');
    rsvp.querySelectorAll('input[name=status]').forEach(r => r.addEventListener('change', () => { const yes = r.value === 'yes' && r.checked; box.hidden = !yes; if (dbox) dbox.hidden = !yes; }));
    const all = document.getElementById('datesAll'), none = document.getElementById('datesNone');
    const setAll = v => rsvp.querySelectorAll('input[name=date_ids]').forEach(c => { c.checked = v; });
    if (all) all.addEventListener('click', e => { e.preventDefault(); setAll(true); });
    if (none) none.addEventListener('click', e => { e.preventDefault(); setAll(false); });
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

  // Núcleo familiar: agregar personas desde el formulario de asistencia + detección de duplicados
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function dupCheck(input, warnEl, aliasEl) {
    const q = input.value.trim(); warnEl.hidden = true; warnEl.innerHTML = ''; if (aliasEl) aliasEl.value = '';
    if (q.length < 2) return;
    try {
      const r = await fetch('/perfil/familia/buscar?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
      const d = await r.json(); let html = '';
      if (d.users.length) html += `<div class="flash warn" style="margin:6px 0"><b>${esc(d.users[0].name)}</b> ya tiene cuenta propia en el sitio: puede confirmar su asistencia por su cuenta. Si es otra persona con el mismo nombre, continúa.</div>`;
      if (d.members.length) {
        const m = d.members[0];
        html += `<div class="flash info" style="margin:6px 0">Ya existe <b>${esc(m.name)}</b>${m.note ? ' (' + esc(m.note) + ')' : ''} en el núcleo de <b>${esc(m.owner)}</b>. ¿Es la misma persona?
          <div class="seg mt" style="max-width:320px"><label><input type="radio" name="dup_${m.id}" value="${m.id}" data-alias><span>Sí, la misma</span></label>
          <label><input type="radio" name="dup_${m.id}" value="" data-alias checked><span>No, es otra</span></label></div></div>`;
      }
      if (html) { warnEl.innerHTML = html; warnEl.hidden = false;
        warnEl.querySelectorAll('[data-alias]').forEach(rb => rb.addEventListener('change', () => { if (aliasEl && rb.checked) aliasEl.value = rb.value; }));
      }
    } catch {}
  }
  const addBtn = document.getElementById('addPerson'), ptpl = document.getElementById('personTpl'), holder = document.getElementById('newPeople');
  if (addBtn && ptpl) {
    addBtn.addEventListener('click', () => {
      const el = ptpl.content.firstElementChild.cloneNode(true);
      const name = el.querySelector('[name=new_name]'), warn = el.querySelector('.dup-warn'), alias = el.querySelector('[name=new_alias]');
      name.addEventListener('blur', () => dupCheck(name, warn, alias));
      el.querySelector('.rm').addEventListener('click', () => el.remove());
      holder.appendChild(el); name.focus();
    });
  }
  document.querySelectorAll('input[data-dupcheck]').forEach(inp => {
    const form = inp.closest('form'); const warn = form.querySelector('.dup-warn'), alias = form.querySelector('[name=alias_of]');
    inp.addEventListener('blur', () => dupCheck(inp, warn, alias));
  });

  // Invitaciones: marcar enviada al abrir WhatsApp
  document.querySelectorAll('a.wa[data-sent]').forEach(a => a.addEventListener('click', () => {
    const csrf = document.querySelector('[name=_csrf]'); if (!csrf) return;
    fetch(a.dataset.sent, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + encodeURIComponent(csrf.value) }).catch(() => {});
    a.textContent = '💬 Reenviar';
  }));

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
