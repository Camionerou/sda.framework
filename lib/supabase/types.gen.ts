export type Json =
  | boolean
  | null
  | number
  | string
  | Json[]
  | { [key: string]: Json | undefined };

type GenericTable = {
  // Generated Supabase table types are intentionally broad here; RPC args below
  // are the contract this app relies on most heavily.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Insert: Record<string, any>;
  Relationships: [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Row: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Update: Record<string, any>;
};

type InviteRow = {
  email: string;
  expires_at: string | null;
  invite_id: string;
  invite_token: string;
  role: string;
};

type IndexingRequestRow = {
  document_id: string;
  progress: number;
  run_id: string;
  stage: string;
  status: string;
};

export type Database = {
  public: {
    CompositeTypes: Record<string, never>;
    Enums: Record<string, string>;
    Functions: {
      accept_tenant_invite: {
        Args: {
          _invite_token: string;
        };
        Returns: Json;
      };
      create_tenant_invite: {
        Args: {
          _email: string;
          _expires_at?: string | null;
          _metadata?: Json;
          _role: string;
          _tenant_id?: string | null;
        };
        Returns: InviteRow[];
      };
      create_document_upload: {
        Args: {
          _byte_size: number;
          _checksum_sha256?: string | null;
          _filename: string;
          _metadata?: Json;
          _mime_type: string;
          _title?: string | null;
        };
        Returns: {
          checksum_sha256: string | null;
          deduped: boolean;
          document_id: string;
          filename: string;
          r2_bucket: string;
          r2_key: string;
          status: string;
          tenant_id: string;
        }[];
      };
      mark_document_upload_failed: {
        Args: {
          _document_id: string;
          _reason: string;
        };
        Returns: Json;
      };
      mark_document_uploaded: {
        Args: {
          _byte_size: number;
          _checksum_sha256?: string | null;
          _document_id: string;
        };
        Returns: Json;
      };
      request_document_indexing: {
        Args: {
          _document_id: string;
          _metadata?: Json;
        };
        Returns: IndexingRequestRow[];
      };
      revoke_tenant_invite: {
        Args: {
          _invite_id: string;
        };
        Returns: Json;
      };
    };
    Tables: {
      [key: string]: GenericTable;
    };
    Views: {
      [key: string]: {
        Relationships: [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Row: Record<string, any>;
      };
    };
  };
};
