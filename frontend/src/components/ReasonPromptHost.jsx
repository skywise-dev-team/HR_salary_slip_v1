import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { registerReasonPrompt } from '../utils/reasonPrompt.js';

export const MIN_REASON_LENGTH = 5;

// Mounted once, near the top of the app. Shows the "why are you making
// this change" dialog whenever the server says a request needs a reason
// before it can be sent for approval (see api/axios.js).
export default function ReasonPromptHost() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const resolver = useRef(null);

  useEffect(() => registerReasonPrompt(() => new Promise((resolve) => {
    // A second request while one dialog is open: cancel the earlier one.
    if (resolver.current) resolver.current(null);
    resolver.current = resolve;
    setText('');
    setOpen(true);
  })), []);

  const finish = (value) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(false);
    if (resolve) resolve(value);
  };

  if (!open) return null;
  const ready = text.trim().length >= MIN_REASON_LENGTH;

  return (
    <Modal title="Remarks" onClose={() => finish(null)} width={560}>
      <form onSubmit={(e) => { e.preventDefault(); if (ready) finish(text.trim()); }}>
        <textarea
          autoFocus
          rows={4}
          maxLength={500}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Designation corrected as per promotion letter dated 01-10-2026"
          style={{ width: '100%' }}
        />
        <div className="muted small" style={{ textAlign: 'right' }}>{text.trim().length}/500</div>
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={() => finish(null)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>Send for approval</button>
        </div>
      </form>
    </Modal>
  );
}
