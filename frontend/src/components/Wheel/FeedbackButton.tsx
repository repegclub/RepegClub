import { useState } from "react";
import { useTranslation } from "react-i18next";
import emailjs from "@emailjs/browser";
import { useWallet } from "../../contexts/WalletContext";
import { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY } from "../../lib/feedbackConfig";

type SendStatus = "idle" | "sending" | "sent" | "error";

export function FeedbackButton() {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;

  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [replyEmail, setReplyEmail] = useState("");
  const [status, setStatus] = useState<SendStatus>("idle");

  function handleClose() {
    setIsOpen(false);
    setStatus("idle");
    setMessage("");
    setReplyEmail("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setStatus("sending");
    try {
      await emailjs.send(
        EMAILJS_SERVICE_ID,
        EMAILJS_TEMPLATE_ID,
        {
          message,
          from_email: replyEmail.trim() || "(no reply email given)",
          wallet_address: address ?? "(no wallet connected)",
        },
        { publicKey: EMAILJS_PUBLIC_KEY },
      );
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  return (
    <>
      <button type="button" className="history-open-btn" onClick={() => setIsOpen(true)}>
        <img src="/wheel-pixel/envelope-icon.png" alt="" className="round-action-btn-icon" />
        <span className="history-open-btn-label">{t("feedback.button")}</span>
      </button>
      {isOpen && (
        <div className="history-overlay" onClick={handleClose}>
          <div className="history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="history-modal-header">
              <h2 className="history-modal-title">{t("feedback.title")}</h2>
              <button type="button" className="history-close-btn" onClick={handleClose}>
                ✕
              </button>
            </div>

            {status === "sent" ? (
              <p className="round-status-note">{t("feedback.sent")}</p>
            ) : (
              <form onSubmit={handleSubmit}>
                <textarea
                  className="feedback-textarea"
                  placeholder={t("feedback.messagePlaceholder")}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={5}
                  required
                />
                <input
                  className="feedback-email-input"
                  type="email"
                  placeholder={t("feedback.emailPlaceholder")}
                  value={replyEmail}
                  onChange={(e) => setReplyEmail(e.target.value)}
                />
                <button
                  type="submit"
                  className="round-action-btn"
                  disabled={status === "sending" || !message.trim()}
                >
                  {status === "sending" ? t("feedback.sending") : t("feedback.send")}
                </button>
                {status === "error" && <p className="round-action-error">{t("feedback.error")}</p>}
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
