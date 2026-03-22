/**
 * Ireland Semiconductor Hubs Data
 *
 * Static data for major semiconductor facilities in Ireland.
 * Used by the map layer to display semiconductor industry locations.
 */

export interface SemiconductorHub {
  id: string;
  name: string;
  company: string;
  lat: number;
  lng: number;
  employees: number;
  business: string;
  website?: string;
  description?: string;
}

/**
 * Major semiconductor facilities in Ireland
 */
export const IRELAND_SEMICONDUCTOR_HUBS: SemiconductorHub[] = [
  {
    id: 'intel-leixlip',
    name: 'Intel Leixlip Fab',
    company: 'Intel Corporation',
    lat: 53.3644,
    lng: -6.4878,
    employees: 4000,
    business: 'Chip Manufacturing (14nm/7nm)',
    website: 'https://www.intel.ie',
    description:
      "Europe's largest semiconductor manufacturing facility. Produces chips for Intel's global operations.",
  },
  {
    id: 'analog-limerick',
    name: 'Analog Devices Limerick',
    company: 'Analog Devices',
    lat: 52.6638,
    lng: -8.6267,
    employees: 1000,
    business: 'Analog Chip Design & Manufacturing',
    website: 'https://www.analog.com',
    description:
      'Design center and manufacturing facility for high-performance analog, mixed-signal, and power management chips.',
  },
  {
    id: 'xilinx-dublin',
    name: 'Xilinx Dublin (AMD)',
    company: 'AMD (formerly Xilinx)',
    lat: 53.3498,
    lng: -6.2603,
    employees: 300,
    business: 'FPGA Chip Design',
    website: 'https://www.amd.com',
    description: 'FPGA chip design center, acquired by AMD in 2022.',
  },
  {
    id: 'molex-shannon',
    name: 'Molex Shannon',
    company: 'Molex',
    lat: 52.7028,
    lng: -8.8819,
    employees: 800,
    business: 'Semiconductor Connectors',
    website: 'https://www.molex.com',
    description:
      'Manufacturing of high-speed connectors for semiconductor and data center applications.',
  },
  {
    id: 'tyndall-cork',
    name: 'Tyndall National Institute',
    company: 'Irish Government Research Institute',
    lat: 51.8969,
    lng: -8.5094,
    employees: 600,
    business: 'Semiconductor & Photonics R&D',
    website: 'https://www.tyndall.ie',
    description:
      "Europe's leading research center for micro/nano-electronics and photonics. Partners with Intel, Analog Devices, and EU Chips Act initiatives.",
  },
];
