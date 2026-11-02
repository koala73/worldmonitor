import type { AIRegulation, RegulatoryAction, CountryRegulationProfile, RegulationDeadline } from '@/types';

const euAiAct = 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj/eng';
const euDigitalOmnibusOnAi = 'https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng';
const coSb26189 = 'https://leg.colorado.gov/bills/sb26-189';
const caSb53 = 'https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260SB53';
const krAiBasicAct = 'https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5%EB%B0%9C%EC%A0%84%EA%B3%BC%EC%8B%A0%EB%A2%B0%EA%B8%B0%EB%B0%98%EC%A1%B0%EC%84%B1%EB%93%B1%EC%97%90%EA%B4%80%ED%95%9C%EA%B8%B0%EB%B3%B8%EB%B2%95';

// Major AI Regulations & Laws Worldwide
export const AI_REGULATIONS: AIRegulation[] = [
  // European Union
  {
    id: 'eu-ai-act',
    name: 'EU Artificial Intelligence Act',
    shortName: 'EU AI Act',
    country: 'European Union',
    region: 'Europe',
    type: 'comprehensive',
    status: 'active',
    announcedDate: '2021-04-21',
    effectiveDate: '2024-08-01',
    deadlines: [
      { date: '2025-02-02', label: 'Prohibited AI practices and AI literacy rules apply', source: euAiAct },
      { date: '2025-08-02', label: 'General-purpose AI model, governance and penalty rules apply', source: euAiAct },
      { date: '2026-08-02', label: 'General application date, including the Article 50 transparency duties', source: euAiAct },
      { date: '2026-12-02', label: 'Ban on AI that generates non-consensual intimate images or child sexual abuse material applies', source: euDigitalOmnibusOnAi },
      { date: '2026-12-02', label: 'Generative AI systems on the market before 2 August 2026 must mark their output (Article 50(2))', source: euDigitalOmnibusOnAi },
      { date: '2027-08-02', label: 'General-purpose AI models on the market before 2 August 2025 must comply', source: euAiAct },
      { date: '2027-12-02', label: 'High-risk AI rules apply to Annex III systems (Article 6(2))', source: euDigitalOmnibusOnAi },
      { date: '2028-08-02', label: 'High-risk AI rules apply to Annex I product systems (Article 6(1))', source: euDigitalOmnibusOnAi },
    ],
    scope: ['General Purpose AI', 'High-Risk AI Systems', 'Prohibited AI Practices', 'Foundation Models'],
    keyProvisions: [
      'Risk-based classification system (Unacceptable, High, Limited, Minimal)',
      'Ban on social scoring, real-time biometric surveillance (with exceptions)',
      'Transparency requirements for foundation models (>10^25 FLOPs)',
      'Mandatory conformity assessments for high-risk AI',
      'AI literacy and human oversight requirements',
      'Ban on AI that generates non-consensual intimate images or child sexual abuse material (from 2 December 2026)',
    ],
    penalties: '€35M or 7% of global annual turnover (whichever is higher)',
    link: euAiAct,
    description: 'World\'s first comprehensive AI regulation framework. Establishes harmonized rules for development and use of AI in the EU. The Digital Omnibus on AI, Regulation (EU) 2026/1744, moved the high-risk rules to 2 December 2027 and 2 August 2028.',
  },
  {
    id: 'eu-gdpr',
    name: 'General Data Protection Regulation (AI provisions)',
    shortName: 'GDPR (AI)',
    country: 'European Union',
    region: 'Europe',
    type: 'sectoral',
    status: 'active',
    announcedDate: '2016-04-27',
    effectiveDate: '2018-05-25',
    scope: ['Automated Decision-Making', 'Profiling', 'Data Processing'],
    keyProvisions: [
      'Right to explanation for automated decisions',
      'Right to object to automated processing',
      'Data minimization for AI training',
      'Privacy by design requirements',
    ],
    penalties: '€20M or 4% of global annual turnover',
    link: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng',
    description: 'Includes provisions on automated decision-making and profiling relevant to AI systems.',
  },

  // United States
  {
    id: 'us-eo-14110',
    name: 'Executive Order on Safe, Secure, and Trustworthy AI',
    shortName: 'Biden AI EO',
    country: 'United States',
    region: 'North America',
    type: 'comprehensive',
    status: 'revoked',
    announcedDate: '2023-10-30',
    effectiveDate: '2023-10-30',
    scope: ['Foundation Models', 'AI Safety', 'National Security', 'Civil Rights'],
    keyProvisions: [
      'Safety testing for dual-use foundation models (>10^26 FLOPs)',
      'Red-teaming requirements before public release',
      'Watermarking of AI-generated content',
      'AI Bill of Rights implementation',
      'NIST AI Risk Management Framework adoption',
    ],
    link: 'https://www.govinfo.gov/content/pkg/FR-2023-11-01/html/2023-24283.htm',
    description: 'Comprehensive executive order establishing US government approach to AI safety and governance. Revoked on January 20, 2025 by Executive Order 14148.',
  },
  {
    id: 'us-blueprint-ai-bill-rights',
    name: 'Blueprint for an AI Bill of Rights',
    shortName: 'AI Bill of Rights',
    country: 'United States',
    region: 'North America',
    type: 'voluntary',
    status: 'active',
    announcedDate: '2022-10-04',
    effectiveDate: '2022-10-04',
    scope: ['Civil Rights', 'Algorithmic Discrimination', 'Data Privacy'],
    keyProvisions: [
      'Safe and effective systems',
      'Algorithmic discrimination protections',
      'Data privacy safeguards',
      'Notice and explanation requirements',
      'Human alternatives and opt-out',
    ],
    link: 'https://bidenwhitehouse.archives.gov/ostp/ai-bill-of-rights/',
    description: 'Non-binding framework for protecting civil rights in the age of AI. No longer on whitehouse.gov; the Biden White House archive keeps it. No formal withdrawal was published.',
  },
  {
    id: 'us-ca-sb53',
    name: 'Transparency in Frontier Artificial Intelligence Act (SB 53)',
    shortName: 'California SB 53',
    country: 'United States',
    region: 'North America',
    type: 'sectoral',
    status: 'active',
    announcedDate: '2025-09-29',
    effectiveDate: '2026-01-01',
    deadlines: [
      { date: '2026-01-01', label: 'Frontier AI framework, transparency report and incident duties apply', source: caSb53 },
    ],
    scope: ['Frontier Models', 'AI Safety', 'Whistleblower Protection'],
    keyProvisions: [
      'Large frontier developers (over $500M revenue) must publish a frontier AI framework',
      'Transparency report when deploying a new frontier model (>10^26 operations)',
      'Critical safety incidents reported to the Office of Emergency Services within 15 days',
      'Whistleblower protections for covered employees',
      'Framework for CalCompute, a public computing cluster',
    ],
    penalties: 'Up to $1M per violation, recovered by the Attorney General',
    link: caSb53,
    description: 'California law on frontier model safety and transparency. Signed and chaptered on September 29, 2025 (Chapter 138, Statutes of 2025).',
  },
  {
    id: 'us-co-sb26-189',
    name: 'Colorado Automated Decision-Making Technology Act (SB 26-189)',
    shortName: 'Colorado ADMT Law',
    country: 'United States',
    region: 'North America',
    type: 'sectoral',
    status: 'active',
    announcedDate: '2026-05-01',
    effectiveDate: '2027-01-01',
    deadlines: [
      { date: '2027-01-01', label: 'Developer and deployer duties apply to consequential decisions', source: coSb26189 },
    ],
    scope: ['Automated Decision-Making', 'Consequential Decisions', 'Consumer Protection'],
    keyProvisions: [
      'Developers give deployers technical documentation for covered systems',
      'Consumer notice at the point of interaction',
      'Plain-language explanation within 30 days of an adverse decision',
      'Rights to correct data and to request human review',
      'Attorney General enforcement, with a 60-day cure notice until 2030',
    ],
    link: coSb26189,
    description: 'Repeals and reenacts the 2024 Colorado AI Act (SB 24-205) as rules for automated decision-making technology in employment, housing, lending, insurance, health care, education and public benefits.',
  },

  // United Kingdom
  {
    id: 'uk-pro-innovation',
    name: 'UK Pro-Innovation Approach to AI Regulation',
    shortName: 'UK AI Framework',
    country: 'United Kingdom',
    region: 'Europe',
    type: 'voluntary',
    status: 'active',
    announcedDate: '2023-03-29',
    effectiveDate: '2023-03-29',
    scope: ['Cross-Sectoral AI Governance', 'Innovation'],
    keyProvisions: [
      '5 cross-sectoral principles: Safety, Transparency, Fairness, Accountability, Contestability',
      'Sector-specific regulators (not centralized)',
      'Focus on innovation-friendly regulation',
      'No immediate new laws',
    ],
    link: 'https://www.gov.uk/government/publications/ai-regulation-a-pro-innovation-approach',
    description: 'Light-touch, principles-based approach favoring innovation over strict regulation.',
  },

  // China
  {
    id: 'cn-algorithm-regulations',
    name: 'Regulations on Algorithm Recommendations',
    shortName: 'China Algorithm Rules',
    country: 'China',
    region: 'Asia',
    type: 'sectoral',
    status: 'active',
    announcedDate: '2021-08-27',
    effectiveDate: '2022-03-01',
    scope: ['Recommendation Algorithms', 'Content Moderation', 'User Profiling'],
    keyProvisions: [
      'Algorithm filing requirements with CAC',
      'User opt-out from algorithmic recommendations',
      'Prohibition on price discrimination',
      'Content aligned with socialist values',
    ],
    link: 'https://www.gov.cn/zhengce/zhengceku/2022-01/04/content_5666429.htm',
    description: 'Regulations governing algorithmic recommendation services and content.',
  },
  {
    id: 'cn-generative-ai',
    name: 'Measures for Generative AI Services',
    shortName: 'China GenAI Rules',
    country: 'China',
    region: 'Asia',
    type: 'sectoral',
    status: 'active',
    announcedDate: '2023-07-13',
    effectiveDate: '2023-08-15',
    scope: ['Generative AI', 'Large Language Models', 'Content Generation'],
    keyProvisions: [
      'Content must reflect socialist core values',
      'Training data security reviews',
      'Real-name verification for users',
      'Labeling of AI-generated content',
      'Registration with authorities before public release',
    ],
    link: 'https://www.gov.cn/zhengce/zhengceku/202307/content_6891752.htm',
    description: 'First national regulation specifically targeting generative AI services.',
  },
  {
    id: 'cn-ai-content-labeling',
    name: 'Measures for Labeling AI-Generated Synthetic Content',
    shortName: 'China AI Labeling Rules',
    country: 'China',
    region: 'Asia',
    type: 'sectoral',
    status: 'active',
    announcedDate: '2025-03-14',
    effectiveDate: '2025-09-01',
    scope: ['Generative AI', 'Synthetic Content', 'Content Platforms'],
    keyProvisions: [
      'Visible labels on AI-generated text, images, audio, video and virtual scenes',
      'Hidden labels in file metadata naming the service provider',
      'Distribution platforms must check metadata and label generated content',
    ],
    link: 'https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm',
    description: 'Issued by the CAC, MIIT, Ministry of Public Security and NRTA. Sets labeling duties for providers and platforms that generate or distribute AI content.',
  },

  // Canada
  {
    id: 'ca-aida',
    name: 'Artificial Intelligence and Data Act (AIDA)',
    shortName: 'AIDA',
    country: 'Canada',
    region: 'North America',
    type: 'comprehensive',
    status: 'lapsed',
    announcedDate: '2022-06-16',
    scope: ['High-Impact AI Systems', 'Algorithmic Harm', 'Data Governance'],
    keyProvisions: [
      'Risk-based approach for high-impact systems',
      'Mandatory impact assessments',
      'Algorithmic transparency requirements',
      'Biased output mitigation',
    ],
    link: 'https://www.parl.ca/legisinfo/en/bill/44-1/c-27',
    description: 'Proposed comprehensive AI law in Bill C-27. The bill was still in committee when the parliamentary session ended on January 6, 2025, and it was not reinstated.',
  },

  // Singapore
  {
    id: 'sg-model-framework',
    name: 'Model AI Governance Framework',
    shortName: 'Singapore Framework',
    country: 'Singapore',
    region: 'Asia',
    type: 'voluntary',
    status: 'active',
    announcedDate: '2020-01-21',
    effectiveDate: '2020-01-21',
    scope: ['AI Governance', 'Ethical AI', 'Risk Management'],
    keyProvisions: [
      'Risk-based governance approach',
      'Internal governance structures',
      'Human oversight in decision-making',
      'Transparency and explainability',
    ],
    link: 'https://www.imda.gov.sg/-/media/imda/files/infocomm-media-landscape/sg-digital/tech-pillars/artificial-intelligence/second-edition-of-the-model-ai-governance-framework.pdf',
    description: 'Voluntary framework providing guidance on responsible AI deployment.',
  },

  // Brazil
  {
    id: 'br-ai-bill',
    name: 'Brazilian AI Regulatory Framework',
    shortName: 'Brazil AI Law',
    country: 'Brazil',
    region: 'South America',
    type: 'comprehensive',
    status: 'proposed',
    announcedDate: '2023-05-03',
    scope: ['AI Systems', 'Algorithmic Rights', 'Data Protection'],
    keyProvisions: [
      'Risk-based classification',
      'Rights of affected individuals',
      'Mandatory impact assessments for high-risk AI',
      'Transparency requirements',
    ],
    link: 'https://www25.senado.leg.br/web/atividade/materias/-/materia/157233',
    description: 'Proposed comprehensive AI law (Bill 2338/2023). The Senate passed it on December 10, 2024. It awaits a special committee report in the Chamber of Deputies.',
  },

  // Japan
  {
    id: 'jp-ai-guidelines',
    name: 'AI Guidelines for Business',
    shortName: 'Japan AI Guidelines',
    country: 'Japan',
    region: 'Asia',
    type: 'voluntary',
    status: 'active',
    announcedDate: '2024-04-19',
    effectiveDate: '2024-04-19',
    scope: ['AI Governance', 'Business Use', 'Risk Management'],
    keyProvisions: [
      'Guidelines for AI developers and users',
      'Risk management frameworks',
      'International cooperation focus',
      'Emphasis on innovation',
    ],
    link: 'https://www.meti.go.jp/shingikai/mono_info_service/ai_shakai_jisso/20260331_report.html',
    description: 'Non-binding guidelines from METI and MIC focusing on fostering AI innovation while managing risks. Version 1.2 was published on March 31, 2026.',
  },
  {
    id: 'jp-ai-promotion-act',
    name: 'Act on the Promotion of Research, Development and Utilization of AI-Related Technologies',
    shortName: 'Japan AI Promotion Act',
    country: 'Japan',
    region: 'Asia',
    type: 'comprehensive',
    status: 'active',
    announcedDate: '2025-05-28',
    effectiveDate: '2025-09-01',
    scope: ['AI Strategy', 'Research and Development', 'Risk Response'],
    keyProvisions: [
      'Cabinet AI Strategy Headquarters',
      'National AI Basic Plan',
      'Government research into AI harms, with guidance and advice to businesses',
      'No penalties',
    ],
    link: 'https://laws.e-gov.go.jp/law/507AC0000000053',
    description: 'Japan\'s first AI law (Act No. 53 of 2025). Partly in force on promulgation on June 4, 2025 and fully in force from September 1, 2025.',
  },

  // South Korea
  {
    id: 'kr-ai-framework',
    name: 'AI Ethics Standards and Trust Framework',
    shortName: 'Korea AI Framework',
    country: 'South Korea',
    region: 'Asia',
    type: 'voluntary',
    status: 'active',
    announcedDate: '2023-09-01',
    effectiveDate: '2023-09-01',
    scope: ['AI Ethics', 'Trust', 'Governance'],
    keyProvisions: [
      '3 core principles: Human dignity, Social benefit, Technical robustness',
      'Self-regulation encouraged',
      'Sectoral guidelines',
    ],
    description: 'Voluntary framework emphasizing ethical AI development and deployment.',
  },
  {
    id: 'kr-ai-basic-act',
    name: 'Framework Act on the Development of Artificial Intelligence and Establishment of Trust',
    shortName: 'Korea AI Basic Act',
    country: 'South Korea',
    region: 'Asia',
    type: 'comprehensive',
    status: 'active',
    announcedDate: '2024-12-26',
    effectiveDate: '2026-01-22',
    deadlines: [
      { date: '2026-01-22', label: 'Act takes effect, including transparency and high-impact AI duties', source: krAiBasicAct },
    ],
    scope: ['High-Impact AI', 'Generative AI', 'AI Industry Promotion'],
    keyProvisions: [
      'Advance notice to users when a product uses high-impact or generative AI',
      'Generative AI output must be marked as AI-generated',
      'Safety and reliability measures for high-impact AI',
      'Foreign providers above set thresholds must appoint a domestic agent',
    ],
    penalties: 'Administrative fines up to KRW 30 million',
    link: krAiBasicAct,
    description: 'Passed on December 26, 2024 and promulgated on January 21, 2025 (Act No. 20676). The science ministry runs a guidance period of at least one year before it imposes fines.',
  },
];

// Recent Regulatory Actions & Timeline
export const REGULATORY_ACTIONS: RegulatoryAction[] = [
  {
    id: 'action-001',
    date: '2024-08-01',
    country: 'European Union',
    title: 'EU AI Act Enters into Force',
    type: 'law-passed',
    regulationId: 'eu-ai-act',
    description: 'The EU AI Act officially entered into force, starting the 24-month implementation period.',
    impact: 'high',
    source: 'Official Journal of the EU',
    sourceUrl: euAiAct,
  },
  {
    id: 'action-002',
    date: '2024-07-26',
    country: 'United States',
    title: 'NIST Releases Generative AI Profile',
    type: 'guideline',
    description: 'NIST published NIST AI 600-1, a Generative AI Profile for its AI Risk Management Framework.',
    impact: 'medium',
    source: 'NIST',
    sourceUrl: 'https://www.nist.gov/itl/ai-risk-management-framework',
  },
  {
    id: 'action-003',
    date: '2025-01-14',
    country: 'United States',
    title: 'White House AI Datacenter Infrastructure EO',
    type: 'executive-order',
    description: 'Executive order to streamline permitting for AI datacenter construction.',
    impact: 'high',
    source: 'Federal Register',
    sourceUrl: 'https://www.govinfo.gov/content/pkg/FR-2025-01-17/html/2025-01395.htm',
  },
  {
    id: 'action-004',
    date: '2023-11-01',
    country: 'United Kingdom',
    title: 'UK AI Safety Summit - Bletchley Declaration',
    type: 'guideline',
    description: '28 countries signed declaration on AI safety cooperation and frontier AI risks.',
    impact: 'high',
    source: 'UK Government',
    sourceUrl: 'https://www.gov.uk/government/publications/ai-safety-summit-2023-the-bletchley-declaration/the-bletchley-declaration-by-countries-attending-the-ai-safety-summit-1-2-november-2023',
  },
  {
    id: 'action-008',
    date: '2025-01-20',
    country: 'United States',
    title: 'AI Executive Order 14110 Revoked',
    type: 'executive-order',
    regulationId: 'us-eo-14110',
    description: 'Executive Order 14148 revoked Executive Order 14110 on safe, secure, and trustworthy AI.',
    impact: 'high',
    source: 'Federal Register',
    sourceUrl: 'https://www.govinfo.gov/content/pkg/FR-2025-01-28/html/2025-01901.htm',
  },
  {
    id: 'action-005',
    date: '2023-10-30',
    country: 'United States',
    title: 'Biden Signs AI Executive Order',
    type: 'executive-order',
    regulationId: 'us-eo-14110',
    description: 'President Biden signed comprehensive executive order on AI safety and security.',
    impact: 'high',
    source: 'Federal Register',
    sourceUrl: 'https://www.govinfo.gov/content/pkg/FR-2023-11-01/html/2023-24283.htm',
  },
  {
    id: 'action-006',
    date: '2023-08-15',
    country: 'China',
    title: 'Generative AI Rules Take Effect',
    type: 'law-passed',
    regulationId: 'cn-generative-ai',
    description: 'China\'s measures for managing generative AI services became enforceable.',
    impact: 'high',
    source: 'CAC',
    sourceUrl: 'https://www.gov.cn/zhengce/zhengceku/202307/content_6891752.htm',
  },
  {
    id: 'action-009',
    date: '2025-01-23',
    country: 'United States',
    title: 'Executive Order 14179 on Removing Barriers to AI',
    type: 'executive-order',
    description: 'Executive Order 14179 ordered a review of actions taken under the revoked Executive Order 14110 and an AI action plan.',
    impact: 'high',
    source: 'Federal Register',
    sourceUrl: 'https://www.govinfo.gov/content/pkg/FR-2025-01-31/html/2025-02172.htm',
  },
  {
    id: 'action-010',
    date: '2025-02-02',
    country: 'European Union',
    title: 'EU AI Act Prohibitions Apply',
    type: 'law-passed',
    regulationId: 'eu-ai-act',
    description: 'Bans on unacceptable-risk AI practices and the AI literacy duty started to apply.',
    impact: 'high',
    source: 'Official Journal of the EU',
    sourceUrl: euAiAct,
  },
  {
    id: 'action-011',
    date: '2025-08-02',
    country: 'European Union',
    title: 'EU AI Act General-Purpose AI Rules Apply',
    type: 'law-passed',
    regulationId: 'eu-ai-act',
    description: 'Obligations for providers of general-purpose AI models, governance and penalty rules started to apply.',
    impact: 'high',
    source: 'Official Journal of the EU',
    sourceUrl: euAiAct,
  },
  {
    id: 'action-012',
    date: '2026-07-24',
    country: 'European Union',
    title: 'Digital Omnibus on AI Published',
    type: 'law-passed',
    regulationId: 'eu-ai-act',
    description: 'Regulation (EU) 2026/1744 amended the AI Act. High-risk rules now apply from 2 December 2027 (Annex III) and 2 August 2028 (Annex I). It entered into force on 27 July 2026.',
    impact: 'high',
    source: 'Official Journal of the EU',
    sourceUrl: euDigitalOmnibusOnAi,
  },
  {
    id: 'action-029',
    date: '2026-08-02',
    country: 'European Union',
    title: 'EU AI Act General Application Date',
    type: 'law-passed',
    regulationId: 'eu-ai-act',
    description: 'Most remaining AI Act rules started to apply, including the Article 50 transparency duties. High-risk rules follow in 2027 and 2028.',
    impact: 'high',
    source: 'Official Journal of the EU',
    sourceUrl: euAiAct,
  },
  {
    id: 'action-013',
    date: '2025-05-19',
    country: 'United States',
    title: 'TAKE IT DOWN Act Signed',
    type: 'law-passed',
    description: 'Public Law 119-12 requires platforms to remove non-consensual intimate images, including AI-generated digital forgeries, and gave them one year to set up a removal process.',
    impact: 'medium',
    source: 'GovInfo',
    sourceUrl: 'https://www.govinfo.gov/content/pkg/PLAW-119publ12/html/PLAW-119publ12.htm',
  },
  {
    id: 'action-014',
    date: '2025-07-23',
    country: 'United States',
    title: 'America\'s AI Action Plan Released',
    type: 'guideline',
    description: 'The White House released "Winning the AI Race: America\'s AI Action Plan".',
    impact: 'high',
    source: 'White House',
    sourceUrl: 'https://www.whitehouse.gov/releases/2025/07/white-house-unveils-americas-ai-action-plan/',
  },
  {
    id: 'action-015',
    date: '2025-12-11',
    country: 'United States',
    title: 'Executive Order 14365 on a National AI Policy Framework',
    type: 'executive-order',
    description: 'Executive Order 14365 set up an AI Litigation Task Force at the Justice Department to challenge state AI laws that conflict with federal policy.',
    impact: 'high',
    source: 'Federal Register',
    sourceUrl: 'https://www.govinfo.gov/content/pkg/FR-2025-12-16/html/2025-23092.htm',
  },
  {
    id: 'action-016',
    date: '2026-01-01',
    country: 'United States',
    title: 'California SB 53 Takes Effect',
    type: 'law-passed',
    regulationId: 'us-ca-sb53',
    description: 'California\'s Transparency in Frontier Artificial Intelligence Act took effect.',
    impact: 'high',
    source: 'California Legislature',
    sourceUrl: caSb53,
  },
  {
    id: 'action-017',
    date: '2026-06-02',
    country: 'United States',
    title: 'Executive Order 14409 on AI Innovation and Security',
    type: 'executive-order',
    description: 'Executive Order 14409 directed agencies to prioritize the cyber defense of federal systems and to work with industry on AI security.',
    impact: 'medium',
    source: 'Federal Register',
    sourceUrl: 'https://www.govinfo.gov/content/pkg/FR-2026-06-05/html/2026-11415.htm',
  },
  {
    id: 'action-018',
    date: '2025-01-13',
    country: 'United Kingdom',
    title: 'UK AI Opportunities Action Plan Published',
    type: 'guideline',
    description: 'The Department for Science, Innovation and Technology published the AI Opportunities Action Plan.',
    impact: 'medium',
    source: 'UK Government',
    sourceUrl: 'https://www.gov.uk/government/publications/ai-opportunities-action-plan',
  },
  {
    id: 'action-019',
    date: '2026-02-05',
    country: 'United Kingdom',
    title: 'UK Automated Decision-Making Rules Take Effect',
    type: 'law-passed',
    description: 'Section 80 of the Data (Use and Access) Act 2025 came into force. It replaces Article 22 of the UK GDPR on automated decision-making.',
    impact: 'medium',
    source: 'legislation.gov.uk',
    sourceUrl: 'https://www.legislation.gov.uk/uksi/2026/82/made',
  },
  {
    id: 'action-020',
    date: '2025-09-01',
    country: 'China',
    title: 'AI Content Labeling Rules Take Effect',
    type: 'law-passed',
    regulationId: 'cn-ai-content-labeling',
    description: 'Providers must label AI-generated text, images, audio and video, and platforms must check the labels.',
    impact: 'high',
    source: 'CAC',
    sourceUrl: 'https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm',
  },
  {
    id: 'action-021',
    date: '2026-01-01',
    country: 'China',
    title: 'Amended Cybersecurity Law Adds AI Provisions',
    type: 'law-passed',
    description: 'The amended Cybersecurity Law took effect, with a new article on AI ethics, risk monitoring and safety supervision.',
    impact: 'medium',
    source: 'CAC',
    sourceUrl: 'https://www.cac.gov.cn/2025-10/29/c_1763461514768457.htm',
  },
  {
    id: 'action-022',
    date: '2025-09-01',
    country: 'Japan',
    title: 'Japan AI Promotion Act Fully in Force',
    type: 'law-passed',
    regulationId: 'jp-ai-promotion-act',
    description: 'All provisions of Japan\'s first AI law took effect, including the AI Strategy Headquarters and the AI Basic Plan.',
    impact: 'medium',
    source: 'Cabinet Office',
    sourceUrl: 'https://www8.cao.go.jp/cstp/ai/ai_act/ai_act.html',
  },
  {
    id: 'action-023',
    date: '2026-07-14',
    country: 'Japan',
    title: 'Japan Adopts Second AI Basic Plan',
    type: 'guideline',
    regulationId: 'jp-ai-promotion-act',
    description: 'The Cabinet adopted the second AI Basic Plan under the AI Promotion Act.',
    impact: 'low',
    source: 'Cabinet Office',
    sourceUrl: 'https://www8.cao.go.jp/cstp/ai/ai_plan/ai_plan.html',
  },
  {
    id: 'action-024',
    date: '2026-01-22',
    country: 'South Korea',
    title: 'Korea AI Basic Act Takes Effect',
    type: 'law-passed',
    regulationId: 'kr-ai-basic-act',
    description: 'South Korea\'s AI Basic Act took effect, with labeling duties for generative AI output and rules for high-impact AI.',
    impact: 'high',
    source: 'Korea Policy Briefing',
    sourceUrl: 'https://www.korea.kr/news/policyNewsView.do?newsId=148958380',
  },
  {
    id: 'action-025',
    date: '2025-11-05',
    country: 'India',
    title: 'India AI Governance Guidelines Released',
    type: 'guideline',
    description: 'MeitY released non-binding AI governance guidelines. They find that a separate AI law is not needed at this stage.',
    impact: 'medium',
    source: 'PIB',
    sourceUrl: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2186639',
  },
  {
    id: 'action-026',
    date: '2026-02-20',
    country: 'India',
    title: 'IT Rules Amendment on Synthetic Content Takes Effect',
    type: 'law-passed',
    description: 'The IT (Intermediary Guidelines and Digital Media Ethics Code) Amendment Rules, 2026 on synthetically generated information came into force.',
    impact: 'medium',
    source: 'Gazette of India',
    sourceUrl: 'https://egazette.gov.in/WriteReadData/2026/269993.pdf',
  },
  {
    id: 'action-027',
    date: '2026-01-22',
    country: 'Singapore',
    title: 'Singapore Model AI Governance Framework for Agentic AI',
    type: 'guideline',
    description: 'IMDA launched a voluntary governance framework for agentic AI.',
    impact: 'low',
    source: 'IMDA',
    sourceUrl: 'https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/press-releases/2026/new-model-ai-governance-framework-for-agentic-ai',
  },
  {
    id: 'action-028',
    date: '2025-12-02',
    country: 'Australia',
    title: 'Australia National AI Plan Released',
    type: 'guideline',
    description: 'The National AI Plan builds on existing laws. The government will not proceed with its earlier proposal for mandatory AI guardrails.',
    impact: 'medium',
    source: 'Department of Industry, Science and Resources',
    sourceUrl: 'https://www.industry.gov.au/publications/national-ai-plan',
  },
];

// Country Regulatory Profiles
export const COUNTRY_REGULATION_PROFILES: CountryRegulationProfile[] = [
  {
    country: 'United States',
    countryCode: 'US',
    stance: 'moderate',
    activeRegulations: ['us-blueprint-ai-bill-rights', 'us-ca-sb53', 'us-co-sb26-189'],
    proposedRegulations: [],
    lastUpdated: '2026-06-02',
    summary: 'No federal AI statute. Federal policy favors deregulation and challenges conflicting state AI laws. States regulate: California SB 53 is in force and Colorado\'s automated decision law applies from 2027.',
  },
  {
    country: 'European Union',
    countryCode: 'EU',
    stance: 'strict',
    activeRegulations: ['eu-ai-act', 'eu-gdpr'],
    proposedRegulations: [],
    lastUpdated: '2026-08-02',
    summary: 'Comprehensive risk-based regulation. World\'s strictest AI governance framework. High-risk rules apply from December 2027 and August 2028.',
  },
  {
    country: 'United Kingdom',
    countryCode: 'GB',
    stance: 'permissive',
    activeRegulations: ['uk-pro-innovation'],
    proposedRegulations: [],
    lastUpdated: '2026-02-05',
    summary: 'Pro-innovation, principles-based approach through existing regulators. No government AI bill. New automated decision-making rules apply from February 2026.',
  },
  {
    country: 'China',
    countryCode: 'CN',
    stance: 'strict',
    activeRegulations: ['cn-algorithm-regulations', 'cn-generative-ai', 'cn-ai-content-labeling'],
    proposedRegulations: [],
    lastUpdated: '2026-01-01',
    summary: 'Content-focused regulation aligned with state values. Registration and AI content labeling requirements. The Cybersecurity Law has an AI article from 2026.',
  },
  {
    country: 'Canada',
    countryCode: 'CA',
    stance: 'moderate',
    activeRegulations: [],
    proposedRegulations: [],
    lastUpdated: '2025-05-13',
    summary: 'No federal AI law. AIDA lapsed with Bill C-27 in January 2025. A Minister of Artificial Intelligence and Digital Innovation was appointed in May 2025.',
  },
  {
    country: 'Singapore',
    countryCode: 'SG',
    stance: 'permissive',
    activeRegulations: ['sg-model-framework'],
    proposedRegulations: [],
    lastUpdated: '2026-01-22',
    summary: 'Voluntary governance frameworks, including ones for generative AI (2024) and agentic AI (2026). Pro-business, innovation-friendly approach.',
  },
  {
    country: 'Japan',
    countryCode: 'JP',
    stance: 'permissive',
    activeRegulations: ['jp-ai-guidelines', 'jp-ai-promotion-act'],
    proposedRegulations: [],
    lastUpdated: '2026-07-14',
    summary: 'AI Promotion Act in force since September 2025, with no penalties. Business guidelines stay voluntary. Focus on innovation and international cooperation.',
  },
  {
    country: 'South Korea',
    countryCode: 'KR',
    stance: 'moderate',
    activeRegulations: ['kr-ai-framework', 'kr-ai-basic-act'],
    proposedRegulations: [],
    lastUpdated: '2026-01-22',
    summary: 'AI Basic Act in force since January 2026: transparency and labeling duties, rules for high-impact AI, and fines up to KRW 30 million.',
  },
  {
    country: 'Brazil',
    countryCode: 'BR',
    stance: 'moderate',
    activeRegulations: [],
    proposedRegulations: ['br-ai-bill'],
    lastUpdated: '2025-03-17',
    summary: 'Comprehensive AI law passed by the Senate in December 2024. In the Chamber of Deputies since March 2025.',
  },
  {
    country: 'India',
    countryCode: 'IN',
    stance: 'permissive',
    activeRegulations: [],
    proposedRegulations: [],
    lastUpdated: '2026-02-20',
    summary: 'No AI-specific law. Non-binding governance guidelines (2025). IT Rules cover synthetically generated content from February 2026.',
  },
  {
    country: 'Australia',
    countryCode: 'AU',
    stance: 'permissive',
    activeRegulations: [],
    proposedRegulations: [],
    lastUpdated: '2025-12-02',
    summary: 'Relies on existing laws and voluntary guidance. The National AI Plan (December 2025) replaced the proposal for mandatory guardrails.',
  },
];

// Helper function to get regulation by ID
export function getRegulationById(id: string): AIRegulation | undefined {
  return AI_REGULATIONS.find(reg => reg.id === id);
}

// Helper function to get country profile
export function getCountryProfile(countryCode: string): CountryRegulationProfile | undefined {
  return COUNTRY_REGULATION_PROFILES.find(profile => profile.countryCode === countryCode);
}

// Helper function to get regulations by country
export function getRegulationsByCountry(country: string): AIRegulation[] {
  return AI_REGULATIONS.filter(reg => reg.country === country);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Dataset dates are calendar days ('YYYY-MM-DD' parses as UTC midnight).
// Compare them with the viewer's local calendar date, also as UTC midnight,
// so a deadline neither passes nor shifts a day west of UTC.
function todayAsUtcMidnight(yearOffset: number = 0): number {
  const now = new Date();
  return Date.UTC(now.getFullYear() + yearOffset, now.getMonth(), now.getDate());
}

// Whole calendar days from the viewer's today to a dataset date; negative once passed
export function daysFromToday(date: string): number {
  return Math.round((Date.parse(date) - todayAsUtcMidnight()) / DAY_MS);
}

function allDeadlines(): RegulationDeadline[] {
  return AI_REGULATIONS.flatMap(regulation => (regulation.deadlines ?? []).map(deadline => ({ regulation, deadline })));
}

const deadlineTime = (entry: RegulationDeadline) => Date.parse(entry.deadline.date);

// Compliance deadlines in the next 12 months, soonest first
export function getUpcomingDeadlines(): RegulationDeadline[] {
  const today = todayAsUtcMidnight();
  const oneYearFromToday = todayAsUtcMidnight(1);

  return allDeadlines()
    .filter(entry => deadlineTime(entry) >= today && deadlineTime(entry) <= oneYearFromToday)
    .sort((a, b) => deadlineTime(a) - deadlineTime(b));
}

// Compliance deadlines after the next 12 months, soonest first
export function getLaterDeadlines(limit: number = 3): RegulationDeadline[] {
  const oneYearFromToday = todayAsUtcMidnight(1);

  return allDeadlines()
    .filter(entry => deadlineTime(entry) > oneYearFromToday)
    .sort((a, b) => deadlineTime(a) - deadlineTime(b))
    .slice(0, limit);
}

// Helper function to get recent regulatory actions (last N months)
export function getRecentActions(months: number = 6): RegulatoryAction[] {
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  return REGULATORY_ACTIONS
    .filter(action => new Date(action.date) >= cutoffDate && Date.parse(action.date) <= todayAsUtcMidnight())
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

// Newest actions regardless of age, for when none fall inside the recent window
export function getLatestActions(limit: number = 10): RegulatoryAction[] {
  return [...REGULATORY_ACTIONS]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);
}

// Deadlines outside the next-12-months window: later ones (soonest first),
// then passed ones (most recent first)
export function getDeadlinesOutsideWindow(limit: number = 3): RegulationDeadline[] {
  const today = todayAsUtcMidnight();
  const passed = allDeadlines()
    .filter(entry => deadlineTime(entry) < today)
    .sort((a, b) => deadlineTime(b) - deadlineTime(a));
  return [...getLaterDeadlines(limit), ...passed].slice(0, limit);
}
