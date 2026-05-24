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
      add_document_to_collection: {
        Args: {
          _collection_id: string;
          _document_id: string;
          _request_context?: Json;
        };
        Returns: Json;
      };
      add_group_member: {
        Args: {
          _group_id: string;
          _request_context?: Json;
          _user_id: string;
        };
        Returns: Json;
      };
      add_workspace_member: {
        Args: {
          _principal_id: string;
          _principal_kind: string;
          _request_context?: Json;
          _role?: string;
          _workspace_id: string;
        };
        Returns: Json;
      };
      archive_collection: {
        Args: {
          _collection_id: string;
          _request_context?: Json;
        };
        Returns: Json;
      };
      archive_document: {
        Args: {
          _document_id: string;
          _request_context?: Json;
        };
        Returns: Json;
      };
      archive_group: {
        Args: {
          _group_id: string;
          _request_context?: Json;
        };
        Returns: Json;
      };
      archive_workspace: {
        Args: {
          _request_context?: Json;
          _workspace_id: string;
        };
        Returns: Json;
      };
      bulk_update_documents: {
        Args: {
          _document_ids: string[];
          _patch: Json;
          _request_context?: Json;
        };
        Returns: Json;
      };
      change_workspace_member_role: {
        Args: {
          _principal_id: string;
          _principal_kind: string;
          _request_context?: Json;
          _role: string;
          _workspace_id: string;
        };
        Returns: Json;
      };
      create_collection: {
        Args: {
          _description?: string | null;
          _name: string;
          _request_context?: Json;
          _slug: string;
          _visibility?: string;
          _workspace_id: string;
        };
        Returns: string;
      };
      create_document_upload: {
        Args: {
          _byte_size?: number | null;
          _checksum_sha256?: string | null;
          _collection_id?: string | null;
          _filename: string;
          _metadata?: Json;
          _mime_type?: string;
          _request_context?: Json;
          _title?: string | null;
          _workspace_id: string;
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
          workspace_id: string;
        }[];
      };
      create_group: {
        Args: {
          _description?: string | null;
          _key: string;
          _metadata?: Json;
          _name: string;
          _request_context?: Json;
        };
        Returns: string;
      };
      create_tag: {
        Args: {
          _color?: string | null;
          _description?: string | null;
          _key: string;
          _label: string;
          _request_context?: Json;
        };
        Returns: string;
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
      create_workspace: {
        Args: {
          _description?: string | null;
          _name: string;
          _request_context?: Json;
          _settings?: Json;
          _slug?: string | null;
        };
        Returns: string;
      };
      delete_workspace: {
        Args: {
          _request_context?: Json;
          _workspace_id: string;
        };
        Returns: Json;
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
      move_document: {
        Args: {
          _collection_ids?: string[] | null;
          _document_id: string;
          _request_context?: Json;
          _to_workspace_id: string;
        };
        Returns: Json;
      };
      remove_document_from_collection: {
        Args: {
          _collection_id: string;
          _document_id: string;
          _request_context?: Json;
        };
        Returns: Json;
      };
      remove_group_member: {
        Args: {
          _group_id: string;
          _request_context?: Json;
          _user_id: string;
        };
        Returns: Json;
      };
      remove_workspace_member: {
        Args: {
          _principal_id: string;
          _principal_kind: string;
          _request_context?: Json;
          _workspace_id: string;
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
      restore_document: {
        Args: {
          _document_id: string;
          _request_context?: Json;
        };
        Returns: Json;
      };
      revoke_tenant_invite: {
        Args: {
          _invite_id: string;
        };
        Returns: Json;
      };
      set_active_workspace: {
        Args: {
          _workspace_id: string;
        };
        Returns: Json;
      };
      set_collection_visibility: {
        Args: {
          _collection_id: string;
          _request_context?: Json;
          _visibility: string;
        };
        Returns: Json;
      };
      tag_document: {
        Args: {
          _document_id: string;
          _request_context?: Json;
          _tag_id: string;
        };
        Returns: Json;
      };
      untag_document: {
        Args: {
          _document_id: string;
          _request_context?: Json;
          _tag_id: string;
        };
        Returns: Json;
      };
      update_collection: {
        Args: {
          _collection_id: string;
          _patch: Json;
          _request_context?: Json;
        };
        Returns: Json;
      };
      update_group: {
        Args: {
          _group_id: string;
          _patch: Json;
          _request_context?: Json;
        };
        Returns: Json;
      };
      update_tag: {
        Args: {
          _patch: Json;
          _request_context?: Json;
          _tag_id: string;
        };
        Returns: Json;
      };
      update_workspace: {
        Args: {
          _patch: Json;
          _request_context?: Json;
          _workspace_id: string;
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
