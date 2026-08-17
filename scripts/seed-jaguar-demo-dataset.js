"use strict";

const API = String(process.env.QUELTU_API_URL || "https://api.queltu.com").replace(/\/$/, "");
const CONTROL_CENTER = "CC-JAGUAR-DEMO";
const ADMIN_PHONE = String(process.env.JAGUAR_ADMIN_PHONE || "+5531988815047").trim();
const PREFIX = "[DEMO JAGUAR]";

const AREAS = [
  { name: "Mina Subterrânea", latitude: -19.8842, longitude: -43.6718 },
  { name: "Planta de Beneficiamento", latitude: -19.8818, longitude: -43.6687 },
  { name: "Manutenção / Oficina", latitude: -19.8865, longitude: -43.6664 },
  { name: "Depósito de Explosivos", latitude: -19.8912, longitude: -43.6751 },
  { name: "Acesso e Superfície", latitude: -19.8787, longitude: -43.6638 }
];

const workers = [
  ["Jordan da Cruz Santos", "+551111000001", "jordan.santos@jaguarmining.com.br", 0],
  ["Marcos Vinícius Oliveira", "+551111000002", "marcos.demo@jaguarmining.com.br", 0],
  ["Ana Paula Ribeiro", "+551111000003", "ana.demo@jaguarmining.com.br", 1],
  ["Rafael Henrique Souza", "+551111000004", "rafael.demo@jaguarmining.com.br", 1],
  ["Camila Ferreira Lima", "+551111000005", "camila.demo@jaguarmining.com.br", 2],
  ["Bruno César Almeida", "+551111000006", "bruno.demo@jaguarmining.com.br", 2],
  ["Juliana Costa Martins", "+551111000007", "juliana.demo@jaguarmining.com.br", 3],
  ["Lucas Gabriel Rocha", "+551111000008", "lucas.demo@jaguarmining.com.br", 3],
  ["Fernanda Alves Pereira", "+551111000009", "fernanda.demo@jaguarmining.com.br", 4],
  ["André Luiz Carvalho", "+551111000010", "andre.demo@jaguarmining.com.br", 4],
  ["Patrícia Gomes Silva", "+551111000011", "patricia.demo@jaguarmining.com.br", 0],
  ["Rodrigo Nunes Barros", "+551111000012", "rodrigo.demo@jaguarmining.com.br", 1],
  ["Daniela Melo Santos", "+551111000013", "daniela.demo@jaguarmining.com.br", 2],
  ["Thiago Reis Moreira", "+551111000014", "thiago.demo@jaguarmining.com.br", 3],
  ["Beatriz Moura Castro", "+551111000015", "beatriz.demo@jaguarmining.com.br", 4],
  ["Eduardo Freitas Lopes", "+551111000016", "eduardo.demo@jaguarmining.com.br", 0],
  ["Larissa Andrade Pinto", "+551111000017", "larissa.demo@jaguarmining.com.br", 1],
  ["Gustavo Teixeira Dias", "+551111000018", "gustavo.demo@jaguarmining.com.br", 2],
  ["Renata Barbosa Cunha", "+551111000019", "renata.demo@jaguarmining.com.br", 3],
  ["Felipe Azevedo Campos", "+551111000020", "felipe.demo@jaguarmining.com.br", 4]
];

const hseProfessionals = [
  ["Deivison Tiago da Silva", "+552222000001", "Deivison.Silva@jaguarmining.com.br", 0],
  ["Carolina Mendes Ferreira", "+552222000002", "carolina.hse.demo@jaguarmining.com.br", 1],
  ["Paulo Henrique Batista", "+552222000003", "paulo.hse.demo@jaguarmining.com.br", 2],
  ["Aline Rodrigues Gomes", "+552222000004", "aline.hse.demo@jaguarmining.com.br", 3],
  ["Márcio Tavares Lima", "+552222000005", "marcio.hse.demo@jaguarmining.com.br", 4],
  ["Natália Cardoso Alves", "+552222000006", "natalia.hse.demo@jaguarmining.com.br", 0]
];

const hseSupervisors = [
  ["Supervisor HSE Mina", "+553333000001", "supervisor.mina.demo@jaguarmining.com.br", 0],
  ["Supervisora HSE Planta", "+553333000002", "supervisor.planta.demo@jaguarmining.com.br", 1],
  ["Supervisor HSE Manutenção", "+553333000003", "supervisor.manutencao.demo@jaguarmining.com.br", 2]
];

const scenarios = [
  ["Quase acidente entre caminhão e pedestre", "Interação equipamento-pessoa detectada no acesso ao nível 850, sem lesão.", 1, 0, "closed"],
  ["Queda de fragmento em galeria", "Fragmento de rocha caiu próximo à frente de serviço durante inspeção geotécnica.", 3, 0, "closed"],
  ["Falha de ventilação auxiliar", "Medição indicou vazão abaixo do padrão antes do início da atividade.", 2, 0, "closed"],
  ["Derramamento de óleo hidráulico", "Vazamento em mangueira de carregadeira contido com kit ambiental.", 2, 1, "closed"],
  ["Proteção removida em correia transportadora", "Inspeção identificou guarda lateral fora de posição.", 3, 1, "closed"],
  ["Princípio de incêndio em painel elétrico", "Fumaça em painel foi controlada pela brigada; circuito isolado.", 4, 1, "closed"],
  ["Bloqueio LOTO incompleto", "Segundo ponto de energia não estava identificado na ordem de bloqueio.", 4, 2, "closed"],
  ["Ferramenta sem inspeção pré-uso", "Esmerilhadeira encontrada sem etiqueta vigente de inspeção.", 2, 2, "closed"],
  ["Exposição a ruído acima do limite", "Dosímetro registrou exposição acima do nível de ação na oficina.", 3, 2, "closed"],
  ["Acesso indevido à área de explosivos", "Trabalhador sem autorização tentou acessar área controlada.", 5, 3, "closed"],
  ["Sinalização insuficiente antes de detonação", "Barreira secundária estava sem placa de restrição.", 4, 3, "closed"],
  ["Desvio em armazenamento de explosivos", "Material incompatível identificado próximo ao paiol.", 4, 3, "closed"],
  ["Atendimento médico por mal-estar", "Trabalhador apresentou tontura durante deslocamento na superfície.", 3, 4, "closed"],
  ["Veículo leve com alarme de ré inoperante", "Falha detectada no checklist; veículo retirado de operação.", 3, 4, "closed"],
  ["Ausência de proteção contra queda", "Linha de vida não estava liberada para início do trabalho.", 5, 2, "closed"],
  ["Instabilidade geotécnica em avaliação", "Trinca observada em parede lateral; área isolada preventivamente.", 5, 0, "on_site"],
  ["Emissão de poeira acima do padrão", "Sistema de aspersão apresentou baixa pressão durante britagem.", 3, 1, "en_route"],
  ["Conduta insegura em manutenção", "Intervenção iniciada antes da conferência cruzada do bloqueio.", 4, 2, "accepted"],
  ["Iluminação deficiente em rota de fuga", "Trecho da rota de evacuação apresenta luminárias inoperantes.", 3, 0, "acknowledged"],
  ["EPI danificado antes do turno", "Cinto de segurança apresentou desgaste e foi segregado.", 2, 4, "active"]
];

function isoDaysAgo(days, hour = 9) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

async function request(path, { method = "GET", token = null, body = null, ok = [200, 201] } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!ok.includes(response.status)) {
    const error = new Error(`${method} ${path} -> HTTP ${response.status}: ${data.message || raw.slice(0, 240)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function loginPanel(phone, panelType = "ADMIN") {
  const challenge = await request("/auth/panel-login", {
    method: "POST",
    body: { phone, panel_type: panelType, channel: "demo" }
  });
  if (!challenge.demo_code) throw new Error(`OTP demo no expuesto para ${phone}; este seed sólo se permite en modo demo`);
  return request("/auth/panel-login", {
    method: "POST",
    body: { phone, panel_type: panelType, code: challenge.demo_code, channel: "demo" }
  });
}

async function loginWorker(phone) {
  const challenge = await request("/auth/request-code", {
    method: "POST",
    body: { phone, channel: "demo", purpose: "LOGIN" }
  });
  if (!challenge.demo_code) throw new Error(`OTP demo no expuesto para trabajador ${phone}`);
  return request("/auth/verify-code", {
    method: "POST",
    body: { phone, code: challenge.demo_code, purpose: "LOGIN" }
  });
}

function tokenFrom(payload) {
  return payload.token || payload.access_token || payload.session_token || payload.mobile_access_token;
}

function userPayload([full_name, phone, email, areaIndex], role) {
  const area = AREAS[areaIndex];
  return {
    control_center_code: CONTROL_CENTER,
    full_name,
    phone,
    email,
    rut: `DEMO-${phone.replace(/\D/g, "").slice(-8)}`,
    role,
    validation_status: "VALIDATED",
    is_active: true,
    declared_address: `${area.name} · Complexo Caeté`,
    work_area: area.name,
    latitude: area.latitude,
    longitude: area.longitude
  };
}

function selectCategories(categories) {
  const active = categories.filter(item => item && item.enabled !== false && item.type);
  if (!active.length) throw new Error("No hay categorías de emergencia habilitadas");
  const preferred = ["FALL_DETECTED", "MEDICAL", "FIRE", "RISK", "SECURITY", "TRAFFIC_ACCIDENT", "SOS_MANUAL", "OTHER"];
  const selected = preferred.map(type => active.find(item => item.type === type)).filter(Boolean);
  return selected.length ? selected : active.slice(0, 8);
}

async function createTicketFromWorker(worker, scenario, category, token, workerUser) {
  const [, , , areaIndex] = worker;
  const [title, description, priority] = scenario;
  const area = AREAS[areaIndex];
  const response = await request("/public/mobile/sos", {
    method: "POST",
    token,
    body: {
      user_id: workerUser.id,
      name: workerUser.full_name,
      phone: workerUser.phone,
      latitude: area.latitude + (areaIndex + 1) * 0.00007,
      longitude: area.longitude - (areaIndex + 1) * 0.00005,
      accuracy: 8,
      battery: 76,
      source: "QUELTU_WORKER_DEMO",
      alert_type: category.type,
      title: `${PREFIX} ${String(scenarios.indexOf(scenario) + 1).padStart(2, "0")} · ${title}`,
      priority,
      description,
      control_center_code: CONTROL_CENTER
    }
  });
  return response.ticket || response.event || response;
}

async function advanceTicket(ticket, target, resolver, supervisor, adminToken) {
  const id = ticket.id || ticket.ticket_id;
  if (!id || target === "active") return;
  await request(`/tickets/${id}/acknowledge`, {
    method: "POST", token: adminToken, body: { operator_user_id: supervisor.id }
  });
  if (target === "acknowledged") return;
  await request(`/tickets/${id}/manual-assign`, {
    method: "POST", token: adminToken,
    body: { resolver_user_id: resolver.id, operator_user_id: supervisor.id, force: true, reason: "Asignação demonstrativa HSE" }
  });
  await request(`/tickets/${id}/accept`, {
    method: "POST", token: adminToken, body: { resolver_user_id: resolver.id }
  });
  if (target === "accepted") return;
  await request(`/tickets/${id}/en-route`, {
    method: "POST", token: adminToken, body: { resolver_user_id: resolver.id }
  });
  if (target === "en_route") return;
  await request(`/tickets/${id}/on-site`, {
    method: "POST", token: adminToken, body: { resolver_user_id: resolver.id }
  });
  if (target === "on_site") return;
  await request(`/tickets/${id}/resolve`, {
    method: "POST", token: adminToken,
    body: { resolver_user_id: resolver.id, resolution_notes: "Condição controlada, evidências coletadas e investigação HSE registrada." }
  });
  await request(`/tickets/${id}/close`, {
    method: "POST", token: adminToken,
    body: { operator_user_id: supervisor.id, closing_notes: "Encerramento demonstrativo aprovado pelo Supervisor HSE." }
  });
}

async function createSafetyData(token, tickets, users) {
  let bootstrap = await request(`/admin/control-centers/${CONTROL_CENTER}/safety/bootstrap?limit=100`, { token });
  const existingIncidentTitles = new Set((bootstrap.incidents || []).map(item => item.title));
  const ticketByTitle = new Map(tickets.map(item => [item.title, item]));

  for (let index = 0; index < scenarios.length; index += 1) {
    const [title, description, priority, areaIndex, target] = scenarios[index];
    const demoTitle = `${PREFIX} Investigação ${String(index + 1).padStart(2, "0")} · ${title}`;
    if (existingIncidentTitles.has(demoTitle)) continue;
    const ticketTitle = `${PREFIX} ${String(index + 1).padStart(2, "0")} · ${title}`;
    const linked = ticketByTitle.get(ticketTitle);
    const closed = target === "closed";
    await request(`/admin/control-centers/${CONTROL_CENTER}/safety/incidents`, {
      method: "POST", token,
      body: {
        linked_ticket_id: linked?.id || null,
        title: demoTitle,
        event_type: priority >= 4 ? "ACCIDENT" : "INCIDENT",
        severity: ["LOW", "LOW", "MEDIUM", "HIGH", "CRITICAL"][priority - 1],
        potential_severity: priority >= 4 ? "CRITICAL" : "HIGH",
        occurred_at: isoDaysAgo(2 + index, 8 + (index % 8)),
        area: AREAS[areaIndex].name,
        description,
        investigation_status: closed ? "CLOSED" : index % 2 ? "INVESTIGATING" : "ACTION_PLAN",
        immediate_actions: "Área isolada, liderança comunicada e condição inicial controlada.",
        root_causes: closed ? ["Falha na verificação prévia", "Barreira preventiva insuficiente"] : []
      }
    });
  }

  bootstrap = await request(`/admin/control-centers/${CONTROL_CENTER}/safety/bootstrap?limit=100`, { token });
  const existingInspectionTitles = new Set((bootstrap.inspections || []).map(item => item.title));
  const inspectionTemplates = [
    ["Inspeção geotécnica semanal · Nível 850", 0, "COMPLIANT", 94],
    ["Checklist pré-operacional · Carregadeira 07", 1, "COMPLIANT", 91],
    ["Auditoria LOTO · Oficina central", 2, "PARTIAL", 76],
    ["Inspeção de paiol e exclusão", 3, "COMPLIANT", 96],
    ["Rota de fuga e iluminação", 4, "NON_COMPLIANT", 68],
    ["Verificação de ventilação auxiliar", 0, "COMPLIANT", 89],
    ["Inspeção de correias e proteções", 1, "PARTIAL", 81],
    ["Observação de trabalho em altura", 2, "COMPLIANT", 93],
    ["Controle de acesso a explosivos", 3, "COMPLIANT", 98],
    ["Segregação veículo-pedestre", 4, "PARTIAL", 79],
    ["Auditoria de EPI crítico", 0, "COMPLIANT", 95],
    ["Inspeção ambiental de contenções", 1, "COMPLIANT", 90]
  ];
  for (let index = 0; index < inspectionTemplates.length; index += 1) {
    const [name, areaIndex, result, score] = inspectionTemplates[index];
    const title = `${PREFIX} ${name}`;
    if (existingInspectionTitles.has(title)) continue;
    await request(`/admin/control-centers/${CONTROL_CENTER}/safety/inspections`, {
      method: "POST", token,
      body: {
        title,
        inspection_type: index % 3 === 0 ? "FIELD_INSPECTION" : "CRITICAL_CONTROL_AUDIT",
        area: AREAS[areaIndex].name,
        scheduled_at: isoDaysAgo(3 + index * 2, 10),
        completed_at: isoDaysAgo(3 + index * 2, 12),
        status: "COMPLETED",
        result,
        score,
        findings: result === "COMPLIANT" ? [] : ["Oportunidade de reforço registrada no plano de ação"],
        notes: "Registro demonstrativo para análise de tendência HSE.",
        inspector_user_id: users.hse[index % users.hse.length].id
      }
    });
  }

  bootstrap = await request(`/admin/control-centers/${CONTROL_CENTER}/safety/bootstrap?limit=100`, { token });
  for (let index = 0; index < (bootstrap.critical_controls || []).length; index += 1) {
    const control = bootstrap.critical_controls[index];
    if (control.latest_verified_at) continue;
    const failed = index === 1 || index === 3;
    await request(`/admin/control-centers/${CONTROL_CENTER}/safety/critical-controls/${control.id}/verifications`, {
      method: "POST", token,
      body: {
        result: failed ? "FAILED" : "EFFECTIVE",
        area: control.work_area || AREAS[index % AREAS.length].name,
        notes: failed ? "Barreira abaixo do padrão; ação corretiva aberta." : "Barreira verificada e operacional.",
        verified_at: isoDaysAgo(1 + index, 11)
      }
    });
  }

  const existingObservationDescriptions = new Set((bootstrap.behavior_observations || []).map(item => item.description));
  for (let index = 0; index < 18; index += 1) {
    const safe = index < 13;
    const description = `${PREFIX} Observação comportamental ${String(index + 1).padStart(2, "0")}`;
    if (existingObservationDescriptions.has(description)) continue;
    await request(`/admin/control-centers/${CONTROL_CENTER}/safety/behavior-observations`, {
      method: "POST", token,
      body: {
        observation_type: safe ? "SAFE" : "AT_RISK",
        category: ["Uso de EPI", "Bloqueio de energia", "Linha de fogo", "Organização da área"][index % 4],
        area: AREAS[index % AREAS.length].name,
        description,
        feedback: safe ? "Prática segura reconhecida no local." : "Orientação imediata realizada e compromisso acordado.",
        observed_at: isoDaysAgo(1 + index, 7 + (index % 9))
      }
    });
  }

  bootstrap = await request(`/admin/control-centers/${CONTROL_CENTER}/safety/bootstrap?limit=100`, { token });
  const incidentRows = (bootstrap.incidents || []).filter(item => String(item.title || "").startsWith(`${PREFIX} Investigação`));
  const existingActionTitles = new Set((bootstrap.actions || []).map(item => item.title));
  const actionTemplates = [
    ["Reforçar segregação veículo-pedestre", "HIGH", "IN_PROGRESS", -2],
    ["Substituir luminárias da rota de fuga", "HIGH", "OPEN", 3],
    ["Atualizar matriz de bloqueio LOTO", "CRITICAL", "IN_PROGRESS", 5],
    ["Instalar proteção fixa na correia", "HIGH", "DONE", -8],
    ["Revisar plano de ventilação auxiliar", "MEDIUM", "DONE", -5],
    ["Treinar equipe sobre exclusão de detonação", "HIGH", "OPEN", 8],
    ["Repor kits de contenção ambiental", "MEDIUM", "DONE", -3],
    ["Auditar cintos de trabalho em altura", "CRITICAL", "OPEN", 1]
  ];
  for (let index = 0; index < actionTemplates.length; index += 1) {
    const [name, priority, status, dueDelta] = actionTemplates[index];
    const title = `${PREFIX} ${name}`;
    if (existingActionTitles.has(title)) continue;
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + dueDelta);
    await request(`/admin/control-centers/${CONTROL_CENTER}/safety/actions`, {
      method: "POST", token,
      body: {
        source_type: "HSE_INVESTIGATION",
        source_id: incidentRows[index % Math.max(1, incidentRows.length)]?.id || null,
        title,
        description: "Ação demonstrativa vinculada à investigação e acompanhada pelo Supervisor HSE.",
        action_type: index % 3 === 0 ? "PREVENTIVE" : "CORRECTIVE",
        priority,
        owner_user_id: users.hse[index % users.hse.length].id,
        owner_name: users.hse[index % users.hse.length].full_name,
        due_date: due.toISOString().slice(0, 10),
        status,
        evidence: status === "DONE" ? [{ note: "Evidência de conclusão validada" }] : []
      }
    });
  }

  const existingCameraIds = new Set((bootstrap.camera_events || []).map(item => item.external_event_id));
  for (let index = 0; index < 6; index += 1) {
    const externalId = `JAGUAR-DEMO-CAM-${String(index + 1).padStart(2, "0")}`;
    if (existingCameraIds.has(externalId)) continue;
    await request(`/admin/control-centers/${CONTROL_CENTER}/safety/camera-events`, {
      method: "POST", token,
      body: {
        provider: "QUELTU_AI_DEMO",
        external_event_id: externalId,
        event_type: ["PPE_NON_COMPLIANCE", "VEHICLE_PEDESTRIAN_PROXIMITY", "RESTRICTED_AREA_ENTRY"][index % 3],
        confidence: 0.86 + index * 0.02,
        camera_id: `CAM-PILAR-${index + 1}`,
        camera_name: `Câmera operacional ${index + 1}`,
        area: AREAS[index % AREAS.length].name,
        occurred_at: isoDaysAgo(index + 1, 14),
        status: index < 4 ? "ACKNOWLEDGED" : "NEW",
        metadata: { demo: true, reviewed_by: index < 4 ? "Supervisor HSE" : null }
      }
    });
  }
}

async function main() {
  console.log(`Conectando a ${API} para poblar exclusivamente ${CONTROL_CENTER}...`);
  const adminLogin = await loginPanel(ADMIN_PHONE, "ADMIN");
  const adminToken = tokenFrom(adminLogin);
  if (!adminToken) throw new Error("La autenticación ADMIN no devolvió token");
  if (String(adminLogin.user?.control_center_code || "").toUpperCase() !== CONTROL_CENTER) {
    throw new Error(`ABORTADO: la sesión pertenece a ${adminLogin.user?.control_center_code || "otro centro"}, no a ${CONTROL_CENTER}`);
  }
  if (String(adminLogin.user?.role || "").toUpperCase() !== "ADMIN") {
    throw new Error(`ABORTADO: se esperaba ADMIN y se recibió ${adminLogin.user?.role}`);
  }

  const allUserPayloads = [
    ...workers.map(item => userPayload(item, "NEIGHBOR")),
    ...hseProfessionals.map(item => userPayload(item, "RESOLVER")),
    ...hseSupervisors.map(item => userPayload(item, "OPERATOR"))
  ];
  const bulk = await request("/admin/users/bulk", {
    method: "POST", token: adminToken, body: { users: allUserPayloads }
  });
  console.log(`Usuarios procesados: ${bulk.results?.length || allUserPayloads.length}`);

  const usersResponse = await request(`/admin/users?control_center_code=${CONTROL_CENTER}&limit=500`, { token: adminToken });
  const users = usersResponse.users || [];
  const byPhone = new Map(users.map(user => [user.phone, user]));
  const workerRows = workers.map(item => byPhone.get(item[1])).filter(Boolean);
  const hseRows = hseProfessionals.map(item => byPhone.get(item[1])).filter(Boolean);
  const supervisorRows = hseSupervisors.map(item => byPhone.get(item[1])).filter(Boolean);
  if (workerRows.length !== workers.length || hseRows.length !== hseProfessionals.length || supervisorRows.length !== hseSupervisors.length) {
    throw new Error("No fue posible verificar todos los usuarios demo creados");
  }

  const categoriesResponse = await request("/settings/emergency-categories", { token: adminToken });
  const categories = selectCategories(categoriesResponse.categories || []);
  const ticketResponse = await request("/tickets?limit=500", { token: adminToken });
  const existingTickets = ticketResponse.tickets || ticketResponse.data || [];
  const existingTitles = new Set(existingTickets.map(ticket => ticket.title));
  const createdTickets = [];

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const expectedTitle = `${PREFIX} ${String(index + 1).padStart(2, "0")} · ${scenario[0]}`;
    if (existingTitles.has(expectedTitle)) continue;
    const worker = workers[index % workers.length];
    const workerRow = byPhone.get(worker[1]);
    const login = await loginWorker(worker[1]);
    const workerToken = tokenFrom(login);
    if (!workerToken) throw new Error(`Login de trabajador sin token: ${worker[1]}`);
    let ticket;
    try {
      ticket = await createTicketFromWorker(worker, scenario, categories[index % categories.length], workerToken, workerRow);
    } catch (error) {
      console.warn(`  SOS trabajador ${index + 1} rechazado (${error.message}); se crea por admisión manual.`);
      const area = AREAS[scenario[3]];
      const manual = await request("/tickets/manual", {
        method: "POST", token: adminToken,
        body: {
          caller_name: workerRow.full_name,
          caller_phone: workerRow.phone,
          reported_address: area.name,
          latitude: area.latitude,
          longitude: area.longitude,
          alert_type: categories[index % categories.length].type,
          title: expectedTitle,
          priority: scenario[2],
          description: scenario[1]
        }
      });
      ticket = manual.ticket;
    }
    createdTickets.push(ticket);
    await advanceTicket(
      ticket,
      scenario[4],
      hseRows[index % hseRows.length],
      supervisorRows[index % supervisorRows.length],
      adminToken
    );
    console.log(`  Ticket ${String(index + 1).padStart(2, "0")}: ${scenario[4]}`);
  }

  const finalTicketsResponse = await request("/tickets?limit=500", { token: adminToken });
  const finalTickets = (finalTicketsResponse.tickets || finalTicketsResponse.data || [])
    .filter(ticket => String(ticket.title || "").startsWith(PREFIX));
  await createSafetyData(adminToken, finalTickets, { workers: workerRows, hse: hseRows, supervisors: supervisorRows });

  const [finalUsers, safety, dashboard] = await Promise.all([
    request(`/admin/users?control_center_code=${CONTROL_CENTER}&limit=500`, { token: adminToken }),
    request(`/admin/control-centers/${CONTROL_CENTER}/safety/bootstrap?limit=100`, { token: adminToken }),
    request(`/dashboard/safety/summary?control_center_code=${CONTROL_CENTER}&limit=100`, { token: adminToken })
  ]);
  const demoTickets = finalTickets;
  const states = demoTickets.reduce((acc, ticket) => {
    acc[ticket.state] = (acc[ticket.state] || 0) + 1;
    return acc;
  }, {});
  const roles = (finalUsers.users || []).reduce((acc, user) => {
    acc[user.role] = (acc[user.role] || 0) + 1;
    return acc;
  }, {});
  console.log("\nSEED JAGUAR COMPLETADO");
  console.log(JSON.stringify({
    control_center: CONTROL_CENTER,
    users_by_role: roles,
    demo_tickets: demoTickets.length,
    demo_ticket_states: states,
    safety_stats: safety.stats,
    dashboard_stats: dashboard.stats,
    safety_records: {
      incidents: (safety.incidents || []).length,
      inspections: (safety.inspections || []).length,
      behavior_observations: (safety.behavior_observations || []).length,
      corrective_actions: (safety.actions || []).length,
      camera_events: (safety.camera_events || []).length
    },
    pnr_documents: (safety.pnr_documents || []).length,
    critical_controls: (safety.critical_controls || []).length,
    created_tickets_this_run: createdTickets.length
  }, null, 2));
}

main().catch(error => {
  console.error(`SEED ABORTADO: ${error.message}`);
  process.exitCode = 1;
});
