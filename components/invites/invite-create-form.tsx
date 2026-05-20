"use client";

import { Check, Copy, Send } from "lucide-react";
import { useActionState, useState } from "react";

import {
  createInviteAction,
  type CreateInviteState
} from "@/app/app/invites/actions";
import { Button } from "@/components/ui/button";

const initialState: CreateInviteState = {
  status: "idle"
};

export function InviteCreateForm() {
  const [state, formAction, isPending] = useActionState(createInviteAction, initialState);
  const [copied, setCopied] = useState(false);

  async function copyInviteUrl() {
    if (!state.inviteUrl) {
      return;
    }

    await navigator.clipboard.writeText(state.inviteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <form action={formAction} className="form-grid">
      <div className="field">
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          autoComplete="email"
          className="input"
          id="email"
          name="email"
          placeholder="persona@empresa.com"
          required
          type="email"
        />
      </div>

      <div className="form-row">
        <div className="field">
          <label className="label" htmlFor="role">
            Rol
          </label>
          <select className="select" defaultValue="member" id="role" name="role">
            <option value="member">Member</option>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="expires_days">
            Expira
          </label>
          <select
            className="select"
            defaultValue="7"
            id="expires_days"
            name="expires_days"
          >
            <option value="1">1 día</option>
            <option value="3">3 días</option>
            <option value="7">7 días</option>
            <option value="14">14 días</option>
            <option value="30">30 días</option>
            <option value="never">Sin expiración</option>
          </select>
        </div>
      </div>

      <Button
        disabled={isPending}
        leftIcon={<Send aria-hidden="true" size={16} />}
        type="submit"
        variant="primary"
      >
        {isPending ? "Creando..." : "Crear invitación"}
      </Button>

      {state.status === "error" ? (
        <div className="alert alert-danger" role="alert">
          <strong>No se pudo crear la invitación.</strong>
          <span>{state.error}</span>
        </div>
      ) : null}

      {state.status === "success" && state.inviteUrl ? (
        <div className="alert alert-success">
          <strong>Invitación creada para {state.email}.</strong>
          <span>
            {state.expiresAt ? "Compartí este link una sola vez." : "Este link no vence automáticamente."}
            {" "}La DB guarda únicamente el hash.
          </span>
          <div className="copy-row">
            <code>{state.inviteUrl}</code>
            <Button
              leftIcon={
                copied ? (
                  <Check aria-hidden="true" size={16} />
                ) : (
                  <Copy aria-hidden="true" size={16} />
                )
              }
              onClick={copyInviteUrl}
              type="button"
              variant="secondary"
            >
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
