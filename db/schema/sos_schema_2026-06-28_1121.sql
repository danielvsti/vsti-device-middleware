--
-- PostgreSQL database dump
--

\restrict J8EzyMmZRHFLRWDr8Pwl9Zpes1MvVMPCiWI0OXaC1Kvdm4P4dHgk9NCfOc3k51P

-- Dumped from database version 18.4 (Debian 18.4-1.pgdg12+1)
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: auth_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_otps (
    id bigint NOT NULL,
    phone text NOT NULL,
    email text,
    channel text NOT NULL,
    purpose text DEFAULT 'LOGIN'::text NOT NULL,
    code_hash text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: auth_otps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_otps_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_otps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_otps_id_seq OWNED BY public.auth_otps.id;


--
-- Name: control_center_sectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.control_center_sectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    control_center_code text NOT NULL,
    sector_code text NOT NULL,
    sector_name text NOT NULL,
    source text,
    official_level text,
    geometry_geojson jsonb NOT NULL,
    properties jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: control_centers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.control_centers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    municipality text,
    region text,
    country text DEFAULT 'CL'::text,
    latitude double precision,
    longitude double precision,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    boundary_geojson jsonb,
    geofence_buffer_meters integer DEFAULT 100,
    map_center_lat double precision,
    map_center_lon double precision,
    map_zoom integer DEFAULT 13
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id text NOT NULL,
    control_center_id uuid,
    name text,
    type text,
    platform_id text,
    last_latitude double precision,
    last_longitude double precision,
    last_seen timestamp without time zone,
    status text DEFAULT 'OFFLINE'::text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: emergency_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergency_contacts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid,
    name text NOT NULL,
    relationship text,
    phone text NOT NULL,
    priority integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: lucia_query_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lucia_query_audit (
    id text NOT NULL,
    user_id text,
    user_role text,
    control_center_id text,
    control_center_code text,
    question text,
    intent text,
    sql_text text,
    row_count integer DEFAULT 0,
    duration_ms integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: mobile_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mobile_events (
    id text NOT NULL,
    user_id text NOT NULL,
    name text,
    phone text,
    latitude double precision,
    longitude double precision,
    accuracy double precision,
    battery integer,
    state text NOT NULL,
    acknowledged boolean DEFAULT false,
    acknowledged_at timestamp without time zone,
    cancelled boolean DEFAULT false,
    cancelled_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    jurisdiction_status text DEFAULT 'IN_JURISDICTION'::text,
    jurisdiction_reason text
);


--
-- Name: resolver_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resolver_locations (
    user_id uuid NOT NULL,
    control_center_id uuid,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    accuracy double precision,
    status text DEFAULT 'AVAILABLE'::text,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: sirens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sirens (
    id text NOT NULL,
    control_center_id uuid,
    name text NOT NULL,
    latitude double precision,
    longitude double precision,
    location text,
    state text DEFAULT 'OFF'::text,
    relay boolean DEFAULT false,
    last_seen timestamp without time zone,
    rssi integer,
    firmware text,
    uptime integer,
    remote_ip text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: ticket_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_actions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    ticket_id uuid,
    actor_user_id uuid,
    actor_role text,
    action_type text NOT NULL,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ticket_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_assignments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    ticket_id uuid,
    resolver_user_id uuid,
    assignment_type text DEFAULT 'AUTO'::text,
    state text DEFAULT 'PENDING'::text,
    distance_meters double precision,
    notified_at timestamp without time zone,
    accepted_at timestamp without time zone,
    rejected_at timestamp without time zone,
    expired_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ticket_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_attachments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    ticket_id uuid,
    uploaded_by uuid,
    file_type text NOT NULL,
    file_url text NOT NULL,
    file_name text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: ticket_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_notes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    ticket_id uuid,
    author_user_id uuid,
    note text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    control_center_id uuid,
    citizen_user_id uuid,
    source_type text NOT NULL,
    source_event_id text,
    alert_type text NOT NULL,
    title text,
    description text,
    state text DEFAULT 'ACTIVE'::text,
    priority integer DEFAULT 3,
    latitude double precision,
    longitude double precision,
    accuracy double precision,
    assigned_operator_id uuid,
    assigned_resolver_id uuid,
    nearest_siren_id text,
    created_at timestamp without time zone DEFAULT now(),
    acknowledged_at timestamp without time zone,
    assigned_at timestamp without time zone,
    resolved_at timestamp without time zone,
    closed_at timestamp without time zone,
    cancelled_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now(),
    jurisdiction_status text DEFAULT 'IN_JURISDICTION'::text,
    jurisdiction_reason text,
    event_sector_code text,
    event_sector_name text,
    event_sector_method text,
    event_sector_source text,
    event_sector_updated_at timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    control_center_id uuid,
    role text NOT NULL,
    validation_status text DEFAULT 'PROVISIONAL_ACTIVE'::text,
    full_name text NOT NULL,
    rut text,
    phone text,
    email text,
    declared_address text,
    latitude double precision,
    longitude double precision,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: auth_otps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_otps ALTER COLUMN id SET DEFAULT nextval('public.auth_otps_id_seq'::regclass);


--
-- Name: auth_otps auth_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_otps
    ADD CONSTRAINT auth_otps_pkey PRIMARY KEY (id);


--
-- Name: control_center_sectors control_center_sectors_control_center_code_sector_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_center_sectors
    ADD CONSTRAINT control_center_sectors_control_center_code_sector_code_key UNIQUE (control_center_code, sector_code);


--
-- Name: control_center_sectors control_center_sectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_center_sectors
    ADD CONSTRAINT control_center_sectors_pkey PRIMARY KEY (id);


--
-- Name: control_centers control_centers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_centers
    ADD CONSTRAINT control_centers_code_key UNIQUE (code);


--
-- Name: control_centers control_centers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.control_centers
    ADD CONSTRAINT control_centers_pkey PRIMARY KEY (id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: emergency_contacts emergency_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_contacts
    ADD CONSTRAINT emergency_contacts_pkey PRIMARY KEY (id);


--
-- Name: lucia_query_audit lucia_query_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lucia_query_audit
    ADD CONSTRAINT lucia_query_audit_pkey PRIMARY KEY (id);


--
-- Name: mobile_events mobile_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mobile_events
    ADD CONSTRAINT mobile_events_pkey PRIMARY KEY (id);


--
-- Name: resolver_locations resolver_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolver_locations
    ADD CONSTRAINT resolver_locations_pkey PRIMARY KEY (user_id);


--
-- Name: sirens sirens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sirens
    ADD CONSTRAINT sirens_pkey PRIMARY KEY (id);


--
-- Name: ticket_actions ticket_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_actions
    ADD CONSTRAINT ticket_actions_pkey PRIMARY KEY (id);


--
-- Name: ticket_assignments ticket_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_assignments
    ADD CONSTRAINT ticket_assignments_pkey PRIMARY KEY (id);


--
-- Name: ticket_attachments ticket_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_pkey PRIMARY KEY (id);


--
-- Name: ticket_notes ticket_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notes
    ADD CONSTRAINT ticket_notes_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_auth_otps_phone_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_otps_phone_created ON public.auth_otps USING btree (phone, created_at DESC);


--
-- Name: idx_control_center_sectors_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_center_sectors_code ON public.control_center_sectors USING btree (control_center_code);


--
-- Name: idx_control_center_sectors_sector_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_control_center_sectors_sector_code ON public.control_center_sectors USING btree (control_center_code, sector_code);


--
-- Name: idx_devices_control_center; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_devices_control_center ON public.devices USING btree (control_center_id);


--
-- Name: idx_lucia_audit_cc_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lucia_audit_cc_created ON public.lucia_query_audit USING btree (control_center_id, created_at DESC);


--
-- Name: idx_resolver_locations_control_center; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resolver_locations_control_center ON public.resolver_locations USING btree (control_center_id);


--
-- Name: idx_resolver_locations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resolver_locations_status ON public.resolver_locations USING btree (status);


--
-- Name: idx_sirens_control_center; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sirens_control_center ON public.sirens USING btree (control_center_id);


--
-- Name: idx_ticket_assignments_resolver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_assignments_resolver ON public.ticket_assignments USING btree (resolver_user_id);


--
-- Name: idx_ticket_assignments_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_assignments_ticket ON public.ticket_assignments USING btree (ticket_id);


--
-- Name: idx_tickets_cc_jurisdiction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_cc_jurisdiction ON public.tickets USING btree (control_center_id, jurisdiction_status, created_at DESC);


--
-- Name: idx_tickets_control_center; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_control_center ON public.tickets USING btree (control_center_id);


--
-- Name: idx_tickets_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_created_at ON public.tickets USING btree (created_at);


--
-- Name: idx_tickets_event_sector_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_event_sector_code ON public.tickets USING btree (control_center_id, event_sector_code);


--
-- Name: idx_tickets_event_sector_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_event_sector_name ON public.tickets USING btree (control_center_id, event_sector_name);


--
-- Name: idx_tickets_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tickets_state ON public.tickets USING btree (state);


--
-- Name: idx_users_control_center; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_control_center ON public.users USING btree (control_center_id);


--
-- Name: devices devices_control_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_control_center_id_fkey FOREIGN KEY (control_center_id) REFERENCES public.control_centers(id);


--
-- Name: emergency_contacts emergency_contacts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_contacts
    ADD CONSTRAINT emergency_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: resolver_locations resolver_locations_control_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolver_locations
    ADD CONSTRAINT resolver_locations_control_center_id_fkey FOREIGN KEY (control_center_id) REFERENCES public.control_centers(id);


--
-- Name: resolver_locations resolver_locations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolver_locations
    ADD CONSTRAINT resolver_locations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: sirens sirens_control_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sirens
    ADD CONSTRAINT sirens_control_center_id_fkey FOREIGN KEY (control_center_id) REFERENCES public.control_centers(id);


--
-- Name: ticket_actions ticket_actions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_actions
    ADD CONSTRAINT ticket_actions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id);


--
-- Name: ticket_actions ticket_actions_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_actions
    ADD CONSTRAINT ticket_actions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_assignments ticket_assignments_resolver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_assignments
    ADD CONSTRAINT ticket_assignments_resolver_user_id_fkey FOREIGN KEY (resolver_user_id) REFERENCES public.users(id);


--
-- Name: ticket_assignments ticket_assignments_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_assignments
    ADD CONSTRAINT ticket_assignments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_attachments ticket_attachments_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_attachments ticket_attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: ticket_notes ticket_notes_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notes
    ADD CONSTRAINT ticket_notes_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.users(id);


--
-- Name: ticket_notes ticket_notes_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_notes
    ADD CONSTRAINT ticket_notes_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: tickets tickets_assigned_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_assigned_operator_id_fkey FOREIGN KEY (assigned_operator_id) REFERENCES public.users(id);


--
-- Name: tickets tickets_assigned_resolver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_assigned_resolver_id_fkey FOREIGN KEY (assigned_resolver_id) REFERENCES public.users(id);


--
-- Name: tickets tickets_citizen_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_citizen_user_id_fkey FOREIGN KEY (citizen_user_id) REFERENCES public.users(id);


--
-- Name: tickets tickets_control_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_control_center_id_fkey FOREIGN KEY (control_center_id) REFERENCES public.control_centers(id);


--
-- Name: tickets tickets_nearest_siren_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_nearest_siren_id_fkey FOREIGN KEY (nearest_siren_id) REFERENCES public.sirens(id);


--
-- Name: users users_control_center_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_control_center_id_fkey FOREIGN KEY (control_center_id) REFERENCES public.control_centers(id);


--
-- PostgreSQL database dump complete
--

\unrestrict J8EzyMmZRHFLRWDr8Pwl9Zpes1MvVMPCiWI0OXaC1Kvdm4P4dHgk9NCfOc3k51P

