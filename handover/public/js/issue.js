import { api, mountAppBar, toast } from './app.js';

const editId = new URLSearchParams(location.search).get('id');
const form = document.getElementById('form');
const submitBtn = document.getElementById('submitBtn');

await mountAppBar({ title: editId ? '引渡票の編集' : '引渡票の発行', back: editId ? `/detail?id=${editId}` : '/' });

/* 編集モードなら既存の内容を流し込む */
if (editId) {
  submitBtn.textContent = '保存する';
  try {
    const { handover } = await api(`/api/handovers/${encodeURIComponent(editId)}`);
    if (handover.status !== 'issued') {
      toast('引渡済み・取消済みの引渡票は編集できません', 'err');
      submitBtn.disabled = true;
    }
    for (const el of form.elements) {
      if (el.name && handover[el.name] != null) el.value = handover[el.name];
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* 引取可能日を入れたら、期限はそれ以降しか選べないようにする */
form.pickup_from.addEventListener('change', () => {
  form.pickup_until.min = form.pickup_from.value || '';
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  submitBtn.disabled = true;

  const body = {};
  for (const el of form.elements) if (el.name) body[el.name] = el.value;
  body.item_count = Number(form.item_count.value);

  try {
    if (editId) {
      await api(`/api/handovers/${encodeURIComponent(editId)}`, { method: 'PUT', body });
      toast('保存しました', 'ok');
      location.href = `/detail?id=${encodeURIComponent(editId)}`;
    } else {
      const { handover } = await api('/api/handovers', { method: 'POST', body });
      // 発行したらそのまま印刷／FAX用の引渡票へ
      location.href = `/sheet?id=${handover.id}`;
    }
  } catch (err) {
    toast(err.message, 'err');
    submitBtn.disabled = false;
  }
});
