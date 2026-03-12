#!/usr/bin/env node

/**
 * NYC Subway Sign Server
 * Version : 1.3.0
 * Updated : 2026-03-11
 * Changes : Fix null crash in display.update() in firmware template.
 *           (data.get('north') or {}).get() handles null safely.
 *           code.py no longer has hardcoded station/zip — all config from Firestore.
 *
 * Fetches MTA GTFS-Realtime data, parses protobuf, and serves a JSON API
 * for Matrix Portal S3 devices. Includes Firestore-backed device config
 * and firmware generation.
 *
 * Requires Node >= 18 (uses native fetch — no node-fetch needed).
 *
 * Local dev: run `gcloud auth application-default login` once so the
 * Firebase Admin SDK can reach Firestore without a key file.
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const admin   = require('firebase-admin');
require('dotenv').config();

// ─── Firebase / Firestore ─────────────────────────────────────────────────────
// Cloud Run: uses the attached service account automatically (ADC).
// Local dev : set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
//             OR run `gcloud auth application-default login`.
admin.initializeApp();
const db = admin.firestore();

// ─── Express setup ────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────
const MTA_API_KEY = process.env.MTA_API_KEY;

// This server's own public URL — injected into generated firmware so devices
// know where to phone home. Override via SERVICE_URL env var if needed.
const SERVICE_URL = process.env.SERVICE_URL || 'https://subway-api-829904256043.us-east1.run.app';

// ─── MTA feed URLs ────────────────────────────────────────────────────────────
const GTFS_FEEDS = {
  'G':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  'L':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'ACE':     'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'BDFM':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'NQRW':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  '123456S': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  '7':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-7',
  'JZ':      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
};

// ─── Station data ─────────────────────────────────────────────────────────────
// Each array: { stop_id, stop_name, routes }
// stop_ids match MTA GTFS static data (stops.txt); N/S suffix appended at query time.

// G line — Court Sq ↔ Church Av
const G_LINE_STATIONS = [
  { stop_id: 'G22', stop_name: 'Court Sq',               routes: ['G', 'E', 'M', '7']  },
  { stop_id: 'G24', stop_name: '21 St',                  routes: ['G']                  },
  { stop_id: 'G26', stop_name: 'Greenpoint Av',          routes: ['G']                  },
  { stop_id: 'G28', stop_name: 'Nassau Av',              routes: ['G']                  },
  { stop_id: 'G29', stop_name: 'Metropolitan Av',        routes: ['G', 'L']             },
  { stop_id: 'G30', stop_name: 'Broadway',               routes: ['G']                  },
  { stop_id: 'G31', stop_name: 'Flushing Av',            routes: ['G']                  },
  { stop_id: 'G32', stop_name: 'Myrtle-Willoughby Avs', routes: ['G']                  },
  { stop_id: 'G33', stop_name: 'Bedford-Nostrand Avs',   routes: ['G']                  },
  { stop_id: 'G34', stop_name: 'Classon Av',             routes: ['G']                  },
  { stop_id: 'G35', stop_name: 'Clinton-Washington Avs', routes: ['G']                  },
  { stop_id: 'G36', stop_name: 'Fulton St',              routes: ['G']                  },
  { stop_id: 'A42', stop_name: 'Hoyt-Schermerhorn Sts', routes: ['G', 'A', 'C']        },
  { stop_id: 'F20', stop_name: 'Bergen St',              routes: ['G', 'F']             },
  { stop_id: 'F21', stop_name: 'Carroll St',             routes: ['G', 'F']             },
  { stop_id: 'F22', stop_name: 'Smith-9 Sts',            routes: ['G', 'F']             },
  { stop_id: 'F23', stop_name: '4 Av-9 St',              routes: ['G', 'F', 'R']        },
  { stop_id: 'F24', stop_name: '7 Av',                   routes: ['G', 'F']             },
  { stop_id: 'F25', stop_name: '15 St-Prospect Park',    routes: ['G', 'F']             },
  { stop_id: 'F26', stop_name: 'Fort Hamilton Pkwy',     routes: ['G', 'F']             },
  { stop_id: 'F27', stop_name: 'Church Av',              routes: ['G', 'F']             },
];

// L line — 8 Av ↔ Canarsie-Rockaway Pkwy
const L_LINE_STATIONS = [
  { stop_id: 'L01', stop_name: '8 Av',                    routes: ['L']                         },
  { stop_id: 'L02', stop_name: '6 Av',                    routes: ['L']                         },
  { stop_id: 'L03', stop_name: 'Union Sq-14 St',          routes: ['L', '4', '5', '6', 'N', 'Q', 'R', 'W'] },
  { stop_id: 'L05', stop_name: '3 Av',                    routes: ['L']                         },
  { stop_id: 'L06', stop_name: '1 Av',                    routes: ['L']                         },
  { stop_id: 'L08', stop_name: 'Bedford Av',              routes: ['L']                         },
  { stop_id: 'L10', stop_name: 'Lorimer St',              routes: ['L']                         },
  { stop_id: 'L11', stop_name: 'Graham Av',               routes: ['L']                         },
  { stop_id: 'L12', stop_name: 'Grand St',                routes: ['L']                         },
  { stop_id: 'L13', stop_name: 'Montrose Av',             routes: ['L']                         },
  { stop_id: 'L14', stop_name: 'Morgan Av',               routes: ['L']                         },
  { stop_id: 'L15', stop_name: 'Jefferson St',            routes: ['L']                         },
  { stop_id: 'L16', stop_name: 'DeKalb Av',               routes: ['L']                         },
  { stop_id: 'L17', stop_name: 'Myrtle-Wyckoff Avs',      routes: ['L', 'M']                    },
  { stop_id: 'L19', stop_name: 'Halsey St',               routes: ['L']                         },
  { stop_id: 'L20', stop_name: 'Wilson Av',               routes: ['L']                         },
  { stop_id: 'L21', stop_name: 'Bushwick Av-Aberdeen St', routes: ['L']                         },
  { stop_id: 'L22', stop_name: 'Broadway Junction',       routes: ['L', 'A', 'C', 'J', 'Z']    },
  { stop_id: 'L24', stop_name: 'Atlantic Av',             routes: ['L']                         },
  { stop_id: 'L25', stop_name: 'Sutter Av-Rutland Rd',    routes: ['L']                         },
  { stop_id: 'L26', stop_name: 'Livonia Av',              routes: ['L']                         },
  { stop_id: 'L27', stop_name: 'New Lots Av',             routes: ['L']                         },
  { stop_id: 'L28', stop_name: 'East 105 St',             routes: ['L']                         },
  { stop_id: 'L29', stop_name: 'Canarsie-Rockaway Pkwy',  routes: ['L']                         },
];

// 7 line — 34 St-Hudson Yards ↔ Flushing-Main St
// N = Manhattan-bound, S = Queens-bound
const SEVEN_LINE_STATIONS = [
  { stop_id: '701', stop_name: 'Flushing-Main St',        routes: ['7']                                        },
  { stop_id: '702', stop_name: 'Mets-Willets Point',      routes: ['7']                                        },
  { stop_id: '705', stop_name: '111 St',                  routes: ['7']                                        },
  { stop_id: '706', stop_name: '103 St-Corona Plaza',     routes: ['7']                                        },
  { stop_id: '707', stop_name: 'Junction Blvd',           routes: ['7']                                        },
  { stop_id: '708', stop_name: '90 St-Elmhurst Av',       routes: ['7']                                        },
  { stop_id: '709', stop_name: '82 St-Jackson Hts',       routes: ['7']                                        },
  { stop_id: '710', stop_name: '74 St-Broadway',          routes: ['7', 'E', 'F', 'M', 'R']                   },
  { stop_id: '711', stop_name: '69 St',                   routes: ['7']                                        },
  { stop_id: '712', stop_name: '61 St-Woodside',          routes: ['7']                                        },
  { stop_id: '713', stop_name: '52 St',                   routes: ['7']                                        },
  { stop_id: '714', stop_name: '46 St-Bliss St',          routes: ['7']                                        },
  { stop_id: '715', stop_name: '40 St-Lowery St',         routes: ['7']                                        },
  { stop_id: '716', stop_name: '33 St-Rawson St',         routes: ['7']                                        },
  { stop_id: '718', stop_name: 'Queensboro Plaza',        routes: ['7', 'N', 'W']                              },
  { stop_id: '719', stop_name: 'Court Sq',                routes: ['7', 'E', 'G', 'M']                        },
  { stop_id: '720', stop_name: 'Hunters Point Av',        routes: ['7']                                        },
  { stop_id: '721', stop_name: 'Vernon Blvd-Jackson Av',  routes: ['7']                                        },
  { stop_id: '723', stop_name: 'Grand Central-42 St',     routes: ['7', '4', '5', '6', 'S']                   },
  { stop_id: '724', stop_name: '5 Av',                    routes: ['7']                                        },
  { stop_id: '725', stop_name: 'Times Sq-42 St',          routes: ['7', '1', '2', '3', 'N', 'Q', 'R', 'W', 'S'] },
  { stop_id: '726', stop_name: '34 St-Hudson Yards',      routes: ['7']                                        },
];

// A/C/E lines — IND 8th Av + Queens Blvd
// A: Inwood-207 St / Far Rockaway / Lefferts Blvd  C: 168 St ↔ Euclid Av  E: Jamaica Center ↔ WTC
const ACE_LINE_STATIONS = [
  { stop_id: 'A02', stop_name: 'Inwood-207 St',                     routes: ['A']                              },
  { stop_id: 'A03', stop_name: 'Dyckman St',                        routes: ['A']                              },
  { stop_id: 'A05', stop_name: '190 St',                            routes: ['A']                              },
  { stop_id: 'A06', stop_name: '181 St',                            routes: ['A']                              },
  { stop_id: 'A07', stop_name: '175 St',                            routes: ['A']                              },
  { stop_id: 'A09', stop_name: '168 St',                            routes: ['A', 'C']                         },
  { stop_id: 'A10', stop_name: '163 St-Amsterdam Av',               routes: ['A', 'C']                         },
  { stop_id: 'A11', stop_name: '155 St',                            routes: ['A', 'C']                         },
  { stop_id: 'A12', stop_name: '145 St',                            routes: ['A', 'C']                         },
  { stop_id: 'A14', stop_name: '135 St',                            routes: ['A', 'B', 'C', 'D']               },
  { stop_id: 'A15', stop_name: '125 St',                            routes: ['A', 'C']                         },
  { stop_id: 'A16', stop_name: '116 St',                            routes: ['A', 'C']                         },
  { stop_id: 'A17', stop_name: 'Cathedral Pkwy (110 St)',           routes: ['A', 'C']                         },
  { stop_id: 'A18', stop_name: '103 St',                            routes: ['A', 'C']                         },
  { stop_id: 'A19', stop_name: '96 St',                             routes: ['A', 'C']                         },
  { stop_id: 'A20', stop_name: '86 St',                             routes: ['A', 'C']                         },
  { stop_id: 'A21', stop_name: '81 St-Museum of Natural History',   routes: ['A', 'B', 'C']                    },
  { stop_id: 'A22', stop_name: '72 St',                             routes: ['A', 'B', 'C']                    },
  { stop_id: 'A24', stop_name: '59 St-Columbus Circle',             routes: ['A', 'B', 'C', 'D']               },
  { stop_id: 'A25', stop_name: '50 St',                             routes: ['A', 'C', 'E']                    },
  { stop_id: 'A27', stop_name: '42 St-Port Authority Bus Terminal', routes: ['A', 'C', 'E']                    },
  { stop_id: 'A28', stop_name: '34 St-Penn Station',                routes: ['A', 'C', 'E']                    },
  { stop_id: 'A30', stop_name: '23 St',                             routes: ['A', 'C', 'E']                    },
  { stop_id: 'A31', stop_name: '14 St',                             routes: ['A', 'C', 'E']                    },
  { stop_id: 'A32', stop_name: 'W 4 St-Wash Sq',                    routes: ['A', 'B', 'C', 'D', 'E', 'F', 'M'] },
  { stop_id: 'A33', stop_name: 'Spring St',                         routes: ['A', 'C', 'E']                    },
  { stop_id: 'A34', stop_name: 'Canal St',                          routes: ['A', 'C', 'E']                    },
  { stop_id: 'A36', stop_name: 'Chambers St',                       routes: ['A', 'C', 'E']                    },
  { stop_id: 'A38', stop_name: 'Fulton St',                         routes: ['A', 'C', 'J', 'Z', '2', '3', '4', '5'] },
  { stop_id: 'A40', stop_name: 'High St',                           routes: ['A', 'C']                         },
  { stop_id: 'A41', stop_name: 'Jay St-MetroTech',                  routes: ['A', 'C', 'F', 'R']               },
  { stop_id: 'A42', stop_name: 'Hoyt-Schermerhorn Sts',             routes: ['A', 'C', 'G']                    },
  { stop_id: 'A43', stop_name: 'Lafayette Av',                      routes: ['A', 'C']                         },
  { stop_id: 'A44', stop_name: 'Clinton-Washington Avs',            routes: ['A', 'C']                         },
  { stop_id: 'A45', stop_name: 'Franklin Av',                       routes: ['A', 'C']                         },
  { stop_id: 'A46', stop_name: 'Nostrand Av',                       routes: ['A', 'C']                         },
  { stop_id: 'A47', stop_name: 'Kingston-Throop Avs',               routes: ['A', 'C']                         },
  { stop_id: 'A48', stop_name: 'Utica Av',                          routes: ['A', 'C']                         },
  { stop_id: 'A49', stop_name: 'Ralph Av',                          routes: ['A']                              },
  { stop_id: 'A50', stop_name: 'Rockaway Av',                       routes: ['A']                              },
  { stop_id: 'A51', stop_name: 'Broadway Junction',                 routes: ['A', 'C', 'J', 'Z', 'L']         },
  { stop_id: 'A52', stop_name: 'Liberty Av',                        routes: ['A']                              },
  { stop_id: 'A53', stop_name: 'Van Siclen Av',                     routes: ['A']                              },
  { stop_id: 'A54', stop_name: 'Shepherd Av',                       routes: ['A']                              },
  { stop_id: 'A55', stop_name: 'Euclid Av',                         routes: ['A', 'C']                         },
  { stop_id: 'A57', stop_name: 'Grant Av',                          routes: ['A']                              },
  { stop_id: 'A59', stop_name: '80 St',                             routes: ['A']                              },
  { stop_id: 'A60', stop_name: '88 St',                             routes: ['A']                              },
  { stop_id: 'A61', stop_name: 'Rockaway Blvd',                     routes: ['A']                              },
  { stop_id: 'A63', stop_name: '104 St',                            routes: ['A']                              },
  { stop_id: 'A64', stop_name: '111 St',                            routes: ['A']                              },
  { stop_id: 'A65', stop_name: 'Ozone Park-Lefferts Blvd',          routes: ['A']                              },
  // Far Rockaway / Rockaway Park branch
  { stop_id: 'H01', stop_name: 'Aqueduct Racetrack',                routes: ['A']                              },
  { stop_id: 'H02', stop_name: 'Aqueduct-N Conduit Av',             routes: ['A']                              },
  { stop_id: 'H03', stop_name: 'Howard Beach-JFK Airport',          routes: ['A']                              },
  { stop_id: 'H04', stop_name: 'Broad Channel',                     routes: ['A', 'S']                         },
  { stop_id: 'H06', stop_name: 'Beach 67 St',                       routes: ['A', 'S']                         },
  { stop_id: 'H07', stop_name: 'Beach 60 St',                       routes: ['A']                              },
  { stop_id: 'H08', stop_name: 'Beach 44 St',                       routes: ['A']                              },
  { stop_id: 'H09', stop_name: 'Beach 36 St',                       routes: ['A']                              },
  { stop_id: 'H10', stop_name: 'Beach 25 St',                       routes: ['A']                              },
  { stop_id: 'H11', stop_name: 'Far Rockaway-Mott Av',              routes: ['A']                              },
  { stop_id: 'H12', stop_name: 'Beach 90 St',                       routes: ['S']                              },
  { stop_id: 'H13', stop_name: 'Beach 98 St',                       routes: ['S']                              },
  { stop_id: 'H14', stop_name: 'Beach 105 St',                      routes: ['S']                              },
  { stop_id: 'H15', stop_name: 'Rockaway Park-Beach 116 St',        routes: ['A', 'S']                         },
  // E train Queens (IND Queens Blvd)
  { stop_id: 'G05', stop_name: 'Jamaica Center-Parsons/Archer',     routes: ['E', 'J', 'Z']                    },
  { stop_id: 'G06', stop_name: 'Sutphin Blvd-Archer Av-JFK',        routes: ['E', 'J', 'Z']                    },
  { stop_id: 'F01', stop_name: 'Jamaica-179 St',                    routes: ['F']                              },
  { stop_id: 'F03', stop_name: 'Parsons Blvd',                      routes: ['E', 'F']                         },
  { stop_id: 'F05', stop_name: 'Briarwood',                         routes: ['E', 'F']                         },
  { stop_id: 'F06', stop_name: 'Kew Gardens-Union Tpke',            routes: ['E', 'F']                         },
  { stop_id: 'F07', stop_name: '75 Av',                             routes: ['E', 'F']                         },
  { stop_id: 'G08', stop_name: 'Forest Hills-71 Av',                routes: ['E', 'F', 'M', 'R']               },
  { stop_id: 'G09', stop_name: '67 Av',                             routes: ['F', 'M', 'R']                    },
  { stop_id: 'G10', stop_name: '63 Dr-Rego Park',                   routes: ['F', 'M', 'R']                    },
  { stop_id: 'G11', stop_name: 'Woodhaven Blvd',                    routes: ['F', 'M', 'R']                    },
  { stop_id: 'G12', stop_name: 'Grand Av-Newtown',                  routes: ['F', 'M', 'R']                    },
  { stop_id: 'G13', stop_name: 'Elmhurst Av',                       routes: ['M', 'R']                         },
  { stop_id: 'G14', stop_name: 'Jackson Hts-Roosevelt Av',          routes: ['E', 'F', 'M', 'R', '7']          },
  { stop_id: 'G15', stop_name: '65 St',                             routes: ['M', 'R']                         },
  { stop_id: 'G16', stop_name: 'Northern Blvd',                     routes: ['M', 'R']                         },
  { stop_id: 'G18', stop_name: '46 St',                             routes: ['M', 'R']                         },
  { stop_id: 'G19', stop_name: 'Steinway St',                       routes: ['M', 'R']                         },
  { stop_id: 'G20', stop_name: '36 St',                             routes: ['M', 'R']                         },
  { stop_id: 'G21', stop_name: 'Queens Plaza',                      routes: ['E', 'M', 'R']                    },
  { stop_id: 'F09', stop_name: 'Court Sq-23 St',                    routes: ['E', 'M']                         },
];

// B/D/F/M lines — IND 6th Av + IND Concourse (D/B Bronx)
const BDFM_LINE_STATIONS = [
  // D line Bronx (IND Concourse)
  { stop_id: 'D01', stop_name: 'Norwood-205 St',                  routes: ['D']                         },
  { stop_id: 'D03', stop_name: 'Bedford Park Blvd-Lehman College',routes: ['B', 'D']                    },
  { stop_id: 'D04', stop_name: 'Kingsbridge Rd',                  routes: ['D']                         },
  { stop_id: 'D05', stop_name: 'Fordham Rd',                      routes: ['D']                         },
  { stop_id: 'D06', stop_name: 'E 182-183 Sts',                   routes: ['D']                         },
  { stop_id: 'D07', stop_name: 'Tremont Av',                      routes: ['D']                         },
  { stop_id: 'D08', stop_name: '174-175 Sts',                     routes: ['D']                         },
  { stop_id: 'D09', stop_name: '170 St',                          routes: ['D']                         },
  { stop_id: 'D10', stop_name: '167 St',                          routes: ['D']                         },
  { stop_id: 'D11', stop_name: '161 St-Yankee Stadium',           routes: ['B', 'D', '4']               },
  { stop_id: 'D12', stop_name: '155 St',                          routes: ['B', 'D']                    },
  { stop_id: 'D13', stop_name: '145 St',                          routes: ['B', 'D']                    },
  // B line Bronx (separate branch to 145 St via Bedford Park)
  { stop_id: 'D14', stop_name: 'Concourse',                       routes: ['B', 'D']                    },
  // Shared 8th Ave upper Manhattan (B/D join A/C track at 59 St)
  { stop_id: 'A14', stop_name: '125 St',                          routes: ['A', 'B', 'C', 'D']          },
  { stop_id: 'A20', stop_name: '81 St-Museum of Natural History', routes: ['A', 'B', 'C']               },
  { stop_id: 'A21', stop_name: '72 St',                           routes: ['A', 'B', 'C']               },
  { stop_id: 'A22', stop_name: '59 St-Columbus Circle',           routes: ['A', 'B', 'C', 'D']          },
  // 6th Av trunk (B/D/F/M)
  { stop_id: 'D15', stop_name: '7 Av',                            routes: ['B', 'D']                    },
  { stop_id: 'D16', stop_name: '47-50 Sts-Rockefeller Ctr',       routes: ['B', 'D', 'F', 'M']          },
  { stop_id: 'D17', stop_name: '42 St-Bryant Park',               routes: ['B', 'D', 'F', 'M']          },
  { stop_id: 'D18', stop_name: '34 St-Herald Sq',                 routes: ['B', 'D', 'F', 'M', 'N', 'Q', 'R', 'W'] },
  { stop_id: 'D19', stop_name: '23 St',                           routes: ['F', 'M']                    },
  { stop_id: 'D20', stop_name: '14 St',                           routes: ['F', 'M']                    },
  { stop_id: 'A30', stop_name: 'W 4 St-Wash Sq',                  routes: ['A', 'B', 'C', 'D', 'E', 'F', 'M'] },
  { stop_id: 'D21', stop_name: 'Broadway-Lafayette St',           routes: ['B', 'D', 'F', 'M']          },
  { stop_id: 'D22', stop_name: 'Grand St',                        routes: ['B', 'D']                    },
  // Brighton Beach branch (B/D)
  { stop_id: 'D24', stop_name: 'DeKalb Av',                       routes: ['B', 'D', 'N', 'Q', 'R']    },
  { stop_id: 'D25', stop_name: 'Atlantic Av-Barclays Ctr',        routes: ['B', 'D', 'N', 'Q', 'R', '2', '3', '4', '5'] },
  { stop_id: 'D26', stop_name: 'Seventh Av',                      routes: ['B', 'Q']                    },
  { stop_id: 'D27', stop_name: 'Prospect Park',                   routes: ['B', 'Q']                    },
  { stop_id: 'D28', stop_name: 'Parkside Av',                     routes: ['B', 'Q']                    },
  { stop_id: 'D29', stop_name: 'Church Av',                       routes: ['B', 'Q']                    },
  { stop_id: 'D30', stop_name: 'Beverly Rd',                      routes: ['B', 'Q']                    },
  { stop_id: 'D31', stop_name: 'Cortelyou Rd',                    routes: ['B', 'Q']                    },
  { stop_id: 'D32', stop_name: 'Newkirk Av',                      routes: ['B', 'Q']                    },
  { stop_id: 'D33', stop_name: 'Avenue H',                        routes: ['B', 'Q']                    },
  { stop_id: 'D34', stop_name: 'Avenue J',                        routes: ['B', 'Q']                    },
  { stop_id: 'D35', stop_name: 'Avenue M',                        routes: ['B', 'Q']                    },
  { stop_id: 'D37', stop_name: 'Kings Hwy',                       routes: ['B', 'Q']                    },
  { stop_id: 'D38', stop_name: 'Avenue U',                        routes: ['B', 'Q']                    },
  { stop_id: 'D39', stop_name: 'Neck Rd',                         routes: ['B']                         },
  { stop_id: 'D40', stop_name: 'Sheepshead Bay',                  routes: ['B', 'Q']                    },
  { stop_id: 'D41', stop_name: 'Brighton Beach',                  routes: ['B', 'Q']                    },
  { stop_id: 'D42', stop_name: 'Ocean Pkwy',                      routes: ['B', 'Q']                    },
  { stop_id: 'D43', stop_name: 'W 8 St-NY Aquarium',              routes: ['B', 'Q']                    },
  { stop_id: 'D44', stop_name: 'Coney Island-Stillwell Av',       routes: ['D', 'F', 'N', 'Q']          },
  // F train Queens (IND Queens Blvd)
  { stop_id: 'G06', stop_name: 'Jamaica-179 St',                  routes: ['E', 'F']                    },
  { stop_id: 'G05', stop_name: 'Parsons Blvd',                    routes: ['E', 'F']                    },
  { stop_id: 'G04', stop_name: 'Briarwood',                       routes: ['E', 'F']                    },
  { stop_id: 'G03', stop_name: 'Kew Gardens-Union Tpke',          routes: ['E', 'F']                    },
  { stop_id: 'G02', stop_name: '75 Av',                           routes: ['E', 'F']                    },
  { stop_id: 'F09', stop_name: 'Forest Hills-71 Av',              routes: ['E', 'F', 'M', 'R']          },
  { stop_id: 'F10', stop_name: '67 Av',                           routes: ['F']                         },
  { stop_id: 'F11', stop_name: '63 Dr-Rego Center',               routes: ['F', 'M', 'R']               },
  { stop_id: 'F12', stop_name: 'Woodhaven Blvd',                  routes: ['F', 'M', 'R']               },
  { stop_id: 'F14', stop_name: 'Jackson Heights-Roosevelt Av',    routes: ['E', 'F', 'M', 'R', '7']     },
  { stop_id: 'F15', stop_name: '74 St-Broadway',                  routes: ['E', 'F', 'M', 'R', '7']     },
  { stop_id: 'F16', stop_name: '65 St',                           routes: ['M', 'R']                    },
  { stop_id: 'F18', stop_name: 'Elmhurst Av',                     routes: ['M', 'R']                    },
  { stop_id: 'F20', stop_name: 'Grand Av-Newtown',                routes: ['M', 'R']                    },
  { stop_id: 'F21', stop_name: 'Woodhaven Blvd',                  routes: ['M', 'R']                    },
  { stop_id: 'F22', stop_name: 'Queens Plaza',                    routes: ['E', 'M', 'R']               },
  { stop_id: 'F23', stop_name: 'Ely Av',                          routes: ['E', 'M']                    },
  { stop_id: 'F24', stop_name: '23 St-Ely Av',                    routes: ['E', 'M']                    },
  { stop_id: 'F25', stop_name: 'Court Sq-23 St',                  routes: ['E', 'M']                    },
  // F Brooklyn
  { stop_id: 'F26', stop_name: 'York St',                         routes: ['F']                         },
  { stop_id: 'F27', stop_name: 'Bergen St',                       routes: ['F', 'G']                    },
  { stop_id: 'F29', stop_name: 'Carroll St',                      routes: ['F', 'G']                    },
  { stop_id: 'F30', stop_name: 'Smith-9 Sts',                     routes: ['F', 'G']                    },
  { stop_id: 'F31', stop_name: '4 Av-9 St',                       routes: ['F', 'G', 'R']               },
  { stop_id: 'F32', stop_name: '7 Av',                            routes: ['F']                         },
  { stop_id: 'F33', stop_name: '15 St-Prospect Park',             routes: ['F', 'G']                    },
  { stop_id: 'F34', stop_name: 'Fort Hamilton Pkwy',              routes: ['F', 'G']                    },
  { stop_id: 'F35', stop_name: 'Church Av',                       routes: ['F']                         },
  { stop_id: 'F36', stop_name: 'Ditmas Av',                       routes: ['F']                         },
  { stop_id: 'F38', stop_name: '18 Av',                           routes: ['F']                         },
  { stop_id: 'F39', stop_name: 'Avenue I',                        routes: ['F']                         },
  { stop_id: 'F40', stop_name: 'Bay Pkwy',                        routes: ['F']                         },
  { stop_id: 'F41', stop_name: 'Avenue N',                        routes: ['F']                         },
  { stop_id: 'F42', stop_name: 'Avenue P',                        routes: ['F']                         },
  { stop_id: 'F43', stop_name: 'Kings Hwy',                       routes: ['F']                         },
  { stop_id: 'F44', stop_name: 'Avenue U',                        routes: ['F']                         },
  { stop_id: 'F45', stop_name: 'Avenue X',                        routes: ['F']                         },
  { stop_id: 'F46', stop_name: 'Neptune Av',                      routes: ['F']                         },
  { stop_id: 'D44', stop_name: 'Coney Island-Stillwell Av',       routes: ['D', 'F', 'N', 'Q']          },
  // M train (Middle Village / Bay Pkwy)
  { stop_id: 'M01', stop_name: 'Middle Village-Metropolitan Av',  routes: ['M']                         },
  { stop_id: 'M04', stop_name: 'Forest Av',                       routes: ['M']                         },
  { stop_id: 'M05', stop_name: 'Fresh Pond Rd',                   routes: ['M']                         },
  { stop_id: 'M06', stop_name: 'Middle Village-Metropolitan Av',  routes: ['M']                         },
  { stop_id: 'M08', stop_name: 'Seneca Av',                       routes: ['M']                         },
  { stop_id: 'M09', stop_name: 'Forest Hills-71 Av',              routes: ['E', 'F', 'M', 'R']          },
  { stop_id: 'M10', stop_name: 'Myrtle-Wyckoff Avs',              routes: ['L', 'M']                    },
  { stop_id: 'M11', stop_name: 'Knickerbocker Av',                routes: ['M']                         },
  { stop_id: 'M12', stop_name: 'Central Av',                      routes: ['M']                         },
  { stop_id: 'M13', stop_name: 'Halsey St',                       routes: ['M']                         },
  { stop_id: 'M14', stop_name: 'Gates Av',                        routes: ['M']                         },
  { stop_id: 'M16', stop_name: 'Flushing Av',                     routes: ['M']                         },
  { stop_id: 'M18', stop_name: 'Lorimer St',                      routes: ['M']                         },
  { stop_id: 'M19', stop_name: 'Hewes St',                        routes: ['J', 'M']                    },
  { stop_id: 'M20', stop_name: 'Marcy Av',                        routes: ['J', 'M']                    },
  { stop_id: 'M21', stop_name: 'Delancey St-Essex St',            routes: ['F', 'J', 'M', 'Z']          },
  { stop_id: 'M22', stop_name: '2 Av',                            routes: ['F']                         },
  { stop_id: 'M23', stop_name: 'Lexington Av-63 St',              routes: ['F']                         },
  { stop_id: 'B08', stop_name: 'Bay Pkwy',                        routes: ['B']                         },
];

// N/Q/R/W lines — BMT Broadway
const NQRW_LINE_STATIONS = [
  // N/W Astoria branch (Queens)
  { stop_id: 'R01', stop_name: 'Astoria-Ditmars Blvd',            routes: ['N', 'W']                    },
  { stop_id: 'R03', stop_name: 'Astoria Blvd',                    routes: ['N', 'W']                    },
  { stop_id: 'R04', stop_name: '30 Av',                           routes: ['N', 'W']                    },
  { stop_id: 'R05', stop_name: 'Broadway',                        routes: ['N', 'W']                    },
  { stop_id: 'R06', stop_name: '36 Av',                           routes: ['N', 'W']                    },
  { stop_id: 'R08', stop_name: '39 Av-Dutch Kills',               routes: ['N', 'W']                    },
  { stop_id: 'R09', stop_name: 'Queensboro Plaza',                routes: ['N', 'W', '7']               },
  // Shared Midtown Manhattan (BMT Broadway)
  { stop_id: 'R11', stop_name: 'Lexington Av-59 St',              routes: ['N', 'R', 'W']               },
  { stop_id: 'R13', stop_name: '5 Av-59 St',                      routes: ['N', 'R', 'W']               },
  { stop_id: 'R14', stop_name: '57 St-7 Av',                      routes: ['N', 'Q', 'R', 'W']          },
  { stop_id: 'R15', stop_name: '49 St',                           routes: ['N', 'R', 'W']               },
  { stop_id: 'R16', stop_name: 'Times Sq-42 St',                  routes: ['N', 'Q', 'R', 'W', '1', '2', '3', '7', 'S'] },
  { stop_id: 'R17', stop_name: '34 St-Herald Sq',                 routes: ['B', 'D', 'F', 'M', 'N', 'Q', 'R', 'W'] },
  { stop_id: 'R18', stop_name: '28 St',                           routes: ['N', 'R', 'W']               },
  { stop_id: 'R19', stop_name: '23 St',                           routes: ['N', 'R', 'W']               },
  { stop_id: 'R20', stop_name: '14 St-Union Sq',                  routes: ['N', 'Q', 'R', 'W', '4', '5', '6', 'L'] },
  { stop_id: 'R21', stop_name: '8 St-NYU',                        routes: ['N', 'R', 'W']               },
  { stop_id: 'R22', stop_name: 'Prince St',                       routes: ['N', 'R', 'W']               },
  { stop_id: 'R23', stop_name: 'Canal St',                        routes: ['N', 'Q', 'R', 'W']          },
  { stop_id: 'R24', stop_name: 'City Hall',                       routes: ['R', 'W']                    },
  { stop_id: 'R25', stop_name: 'Cortlandt St',                    routes: ['R', 'W']                    },
  { stop_id: 'R26', stop_name: 'Rector St',                       routes: ['R', 'W']                    },
  { stop_id: 'R27', stop_name: 'Whitehall St-South Ferry',        routes: ['N', 'R', 'W']               },
  // R/W Brooklyn (4th Av)
  { stop_id: 'R28', stop_name: 'Court St',                        routes: ['R']                         },
  { stop_id: 'R29', stop_name: 'Jay St-MetroTech',                routes: ['A', 'C', 'F', 'R']          },
  { stop_id: 'R30', stop_name: 'DeKalb Av',                       routes: ['B', 'D', 'N', 'Q', 'R']    },
  { stop_id: 'R31', stop_name: 'Atlantic Av-Barclays Ctr',        routes: ['B', 'D', 'N', 'Q', 'R', '2', '3', '4', '5'] },
  { stop_id: 'R32', stop_name: 'Union St',                        routes: ['R']                         },
  { stop_id: 'R33', stop_name: '4 Av-9 St',                       routes: ['F', 'G', 'R']               },
  { stop_id: 'R34', stop_name: 'Smith-9 Sts',                     routes: ['F', 'G', 'R']               },
  { stop_id: 'R35', stop_name: 'Prospect Av',                     routes: ['R']                         },
  { stop_id: 'R36', stop_name: '25 St',                           routes: ['R']                         },
  { stop_id: 'R37', stop_name: '36 St',                           routes: ['D', 'N', 'R']               },
  { stop_id: 'R38', stop_name: '45 St',                           routes: ['R']                         },
  { stop_id: 'R39', stop_name: '53 St',                           routes: ['R']                         },
  { stop_id: 'R40', stop_name: '59 St',                           routes: ['N', 'R']                    },
  { stop_id: 'R41', stop_name: 'Bay Ridge Av',                    routes: ['R']                         },
  { stop_id: 'R43', stop_name: '77 St',                           routes: ['R']                         },
  { stop_id: 'R44', stop_name: '86 St',                           routes: ['R']                         },
  { stop_id: 'R45', stop_name: 'Bay Ridge-95 St',                 routes: ['R']                         },
  // N/Q Brighton Beach / Coney Island
  { stop_id: 'N02', stop_name: 'Queensboro Plaza',                routes: ['N', 'W', '7']               },
  { stop_id: 'N03', stop_name: 'Ditmars Blvd',                    routes: ['N', 'W']                    },
  { stop_id: 'N10', stop_name: '36 St',                           routes: ['D', 'N', 'R']               },
  { stop_id: 'Q01', stop_name: '96 St',                           routes: ['Q']                         },
  { stop_id: 'Q03', stop_name: '86 St',                           routes: ['Q']                         },
  { stop_id: 'Q04', stop_name: '72 St',                           routes: ['Q']                         },
  { stop_id: 'Q05', stop_name: '57 St',                           routes: ['Q']                         },
  { stop_id: 'D44', stop_name: 'Coney Island-Stillwell Av',       routes: ['D', 'F', 'N', 'Q']          },
];

// 1/2/3 lines — IRT 7th Av
const LINE_123_STATIONS = [
  // 1 train (Van Cortlandt Park-242 St ↔ South Ferry)
  { stop_id: '101', stop_name: 'Van Cortlandt Park-242 St',       routes: ['1']                         },
  { stop_id: '103', stop_name: '238 St',                          routes: ['1']                         },
  { stop_id: '104', stop_name: '231 St',                          routes: ['1']                         },
  { stop_id: '106', stop_name: 'Marble Hill-225 St',              routes: ['1']                         },
  { stop_id: '107', stop_name: '215 St',                          routes: ['1']                         },
  { stop_id: '108', stop_name: 'Dyckman St',                      routes: ['1']                         },
  { stop_id: '109', stop_name: '191 St',                          routes: ['1']                         },
  { stop_id: '110', stop_name: '181 St',                          routes: ['1']                         },
  { stop_id: '111', stop_name: '168 St-Washington Heights',       routes: ['1', 'A', 'C']               },
  { stop_id: '112', stop_name: '157 St',                          routes: ['1']                         },
  { stop_id: '113', stop_name: '145 St',                          routes: ['1']                         },
  { stop_id: '114', stop_name: '137 St-City College',             routes: ['1']                         },
  { stop_id: '115', stop_name: '125 St',                          routes: ['1']                         },
  { stop_id: '116', stop_name: '116 St-Columbia University',      routes: ['1']                         },
  { stop_id: '117', stop_name: 'Cathedral Pkwy (110 St)',         routes: ['1']                         },
  { stop_id: '118', stop_name: '103 St',                          routes: ['1']                         },
  { stop_id: '119', stop_name: '96 St',                           routes: ['1', '2', '3']               },
  { stop_id: '120', stop_name: '86 St',                           routes: ['1']                         },
  { stop_id: '121', stop_name: '79 St',                           routes: ['1']                         },
  { stop_id: '122', stop_name: '72 St',                           routes: ['1', '2', '3']               },
  { stop_id: '123', stop_name: '66 St-Lincoln Center',            routes: ['1']                         },
  { stop_id: '124', stop_name: '59 St-Columbus Circle',           routes: ['1', 'A', 'B', 'C', 'D']    },
  { stop_id: '125', stop_name: '50 St',                           routes: ['1']                         },
  { stop_id: '127', stop_name: 'Times Sq-42 St',                  routes: ['1', '2', '3', 'N', 'Q', 'R', 'W', '7', 'S'] },
  { stop_id: '128', stop_name: '34 St-Penn Station',              routes: ['1', '2', '3']               },
  { stop_id: '129', stop_name: '28 St',                           routes: ['1']                         },
  { stop_id: '130', stop_name: '23 St',                           routes: ['1']                         },
  { stop_id: '131', stop_name: '18 St',                           routes: ['1']                         },
  { stop_id: '132', stop_name: '14 St',                           routes: ['1', '2', '3']               },
  { stop_id: '133', stop_name: 'Christopher St-Sheridan Sq',      routes: ['1']                         },
  { stop_id: '134', stop_name: 'Houston St',                      routes: ['1']                         },
  { stop_id: '135', stop_name: 'Canal St',                        routes: ['1']                         },
  { stop_id: '136', stop_name: 'Franklin St',                     routes: ['1']                         },
  { stop_id: '137', stop_name: 'Chambers St',                     routes: ['1', '2', '3']               },
  { stop_id: '138', stop_name: 'Cortlandt St-WTC',                routes: ['1']                         },
  { stop_id: '139', stop_name: 'Rector St',                       routes: ['1']                         },
  { stop_id: '140', stop_name: 'South Ferry',                     routes: ['1']                         },
  // 2 train Bronx branch
  { stop_id: '201', stop_name: 'Wakefield-241 St',                routes: ['2']                         },
  { stop_id: '204', stop_name: 'Nereid Av',                       routes: ['2']                         },
  { stop_id: '205', stop_name: '233 St',                          routes: ['2']                         },
  { stop_id: '206', stop_name: '225 St',                          routes: ['2']                         },
  { stop_id: '207', stop_name: '219 St',                          routes: ['2']                         },
  { stop_id: '208', stop_name: 'Gun Hill Rd',                     routes: ['2']                         },
  { stop_id: '209', stop_name: 'Burke Av',                        routes: ['2']                         },
  { stop_id: '210', stop_name: 'Allerton Av',                     routes: ['2']                         },
  { stop_id: '211', stop_name: 'Pelham Pkwy',                     routes: ['2']                         },
  { stop_id: '212', stop_name: 'Bronx Park East',                 routes: ['2']                         },
  { stop_id: '213', stop_name: 'E 180 St',                        routes: ['2', '5']                    },
  { stop_id: '214', stop_name: 'West Farms Sq-E Tremont Av',      routes: ['2', '5']                    },
  { stop_id: '215', stop_name: '174 St',                          routes: ['2']                         },
  { stop_id: '216', stop_name: 'Freeman St',                      routes: ['2']                         },
  { stop_id: '217', stop_name: 'Simpson St',                      routes: ['2']                         },
  { stop_id: '218', stop_name: 'Intervale Av',                    routes: ['2']                         },
  { stop_id: '219', stop_name: 'Prospect Av',                     routes: ['2', '5']                    },
  { stop_id: '220', stop_name: 'Jackson Av',                      routes: ['2', '5']                    },
  { stop_id: '221', stop_name: 'Third Av-149 St',                 routes: ['2', '5']                    },
  { stop_id: '222', stop_name: '149 St-Grand Concourse',          routes: ['2', '4', '5']               },
  // 2/3 shared Harlem
  { stop_id: '224', stop_name: '135 St',                          routes: ['2', '3']                    },
  { stop_id: '225', stop_name: '125 St',                          routes: ['2', '3']                    },
  { stop_id: '226', stop_name: '116 St',                          routes: ['2', '3']                    },
  { stop_id: '227', stop_name: 'Central Park North-110 St',       routes: ['2', '3']                    },
  // 3 train Brooklyn branch
  { stop_id: '234', stop_name: 'Clark St',                        routes: ['2', '3']                    },
  { stop_id: '235', stop_name: 'Borough Hall',                    routes: ['2', '3', '4', '5']          },
  { stop_id: '236', stop_name: 'Hoyt St',                         routes: ['2', '3']                    },
  { stop_id: '237', stop_name: 'Nevins St',                       routes: ['2', '3']                    },
  { stop_id: '238', stop_name: 'Atlantic Av-Barclays Ctr',        routes: ['2', '3', '4', '5', 'B', 'D', 'N', 'Q', 'R'] },
  { stop_id: '239', stop_name: 'Bergen St',                       routes: ['2', '3']                    },
  { stop_id: '241', stop_name: 'Grand Army Plaza',                routes: ['2', '3']                    },
  { stop_id: '242', stop_name: 'Eastern Pkwy-Brooklyn Museum',    routes: ['2', '3']                    },
  { stop_id: '243', stop_name: 'Crown Heights-Utica Av',          routes: ['3', '4']                    },
  { stop_id: '244', stop_name: 'Sutter Av-Rutland Rd',            routes: ['3']                         },
  { stop_id: '245', stop_name: 'Saratoga Av',                     routes: ['3']                         },
  { stop_id: '246', stop_name: 'Rockaway Av',                     routes: ['3']                         },
  { stop_id: '247', stop_name: 'Junius St',                       routes: ['3']                         },
  { stop_id: '248', stop_name: 'Pennsylvania Av',                 routes: ['3']                         },
  { stop_id: '249', stop_name: 'New Lots Av',                     routes: ['3']                         },
  // 2 train Brooklyn (Flatbush Av)
  { stop_id: '250', stop_name: 'East New York',                   routes: ['2', '3', 'A', 'C']          },
  { stop_id: '251', stop_name: 'Van Siclen Av',                   routes: ['2']                         },
  { stop_id: '252', stop_name: 'Alabama Av',                      routes: ['2']                         },
  { stop_id: '253', stop_name: 'Broadway Junction',               routes: ['2', '3', 'A', 'C', 'J', 'Z', 'L'] },
  { stop_id: '254', stop_name: 'Atlantic Av',                     routes: ['2']                         },
  { stop_id: '255', stop_name: 'Livonia Av',                      routes: ['2', '5']                    },
  { stop_id: '256', stop_name: 'Junius St',                       routes: ['2', '5']                    },
  { stop_id: '257', stop_name: 'New Lots Av',                     routes: ['2', '5']                    },
  { stop_id: '258', stop_name: 'East 105 St',                     routes: ['2', '5']                    },
  { stop_id: '259', stop_name: 'Flatbush Av-Brooklyn College',    routes: ['2', '5']                    },
];

// 4/5/6 lines — IRT Lexington Av
const LINE_456_STATIONS = [
  // 4 train Bronx (Woodlawn branch)
  { stop_id: '401', stop_name: 'Woodlawn',                        routes: ['4']                         },
  { stop_id: '402', stop_name: 'Mosholu Pkwy',                    routes: ['4']                         },
  { stop_id: '405', stop_name: 'Bedford Park Blvd-Lehman College',routes: ['4']                         },
  { stop_id: '406', stop_name: 'Kingsbridge Rd',                  routes: ['4']                         },
  { stop_id: '407', stop_name: 'Fordham Rd',                      routes: ['4']                         },
  { stop_id: '408', stop_name: 'E 182-183 Sts',                   routes: ['4']                         },
  { stop_id: '409', stop_name: 'Burnside Av',                     routes: ['4']                         },
  { stop_id: '410', stop_name: '176 St',                          routes: ['4']                         },
  { stop_id: '411', stop_name: 'Mt Eden Av',                      routes: ['4']                         },
  { stop_id: '412', stop_name: '170 St',                          routes: ['4']                         },
  { stop_id: '413', stop_name: '167 St',                          routes: ['4']                         },
  { stop_id: '414', stop_name: '161 St-Yankee Stadium',           routes: ['4', 'B', 'D']               },
  { stop_id: '415', stop_name: '149 St-Grand Concourse',          routes: ['4', '5']                    },
  { stop_id: '416', stop_name: '138 St-Grand Concourse',          routes: ['4', '5']                    },
  // 5 train Bronx (Dyre Av branch)
  { stop_id: '501', stop_name: 'Eastchester-Dyre Av',             routes: ['5']                         },
  { stop_id: '502', stop_name: 'Baychester Av',                   routes: ['5']                         },
  { stop_id: '503', stop_name: 'Gun Hill Rd',                     routes: ['5']                         },
  { stop_id: '504', stop_name: 'Pelham Pkwy',                     routes: ['5']                         },
  { stop_id: '505', stop_name: 'Morris Park',                     routes: ['5']                         },
  // 4/5/6 shared Manhattan (IRT Lexington Av)
  { stop_id: '621', stop_name: '125 St',                          routes: ['4', '5', '6']               },
  { stop_id: '622', stop_name: '116 St',                          routes: ['6']                         },
  { stop_id: '623', stop_name: '110 St',                          routes: ['6']                         },
  { stop_id: '624', stop_name: '103 St',                          routes: ['6']                         },
  { stop_id: '625', stop_name: '96 St',                           routes: ['6']                         },
  { stop_id: '626', stop_name: '86 St',                           routes: ['4', '5', '6']               },
  { stop_id: '627', stop_name: '77 St',                           routes: ['6']                         },
  { stop_id: '628', stop_name: '68 St-Hunter College',            routes: ['6']                         },
  { stop_id: '629', stop_name: 'Lexington Av-59 St',              routes: ['4', '5', '6']               },
  { stop_id: '630', stop_name: '51 St',                           routes: ['6']                         },
  { stop_id: '631', stop_name: 'Grand Central-42 St',             routes: ['4', '5', '6', '7', 'S']    },
  { stop_id: '632', stop_name: '33 St',                           routes: ['6']                         },
  { stop_id: '633', stop_name: '28 St',                           routes: ['6']                         },
  { stop_id: '634', stop_name: '23 St',                           routes: ['6']                         },
  { stop_id: '635', stop_name: '14 St-Union Sq',                  routes: ['4', '5', '6', 'N', 'Q', 'R', 'W', 'L'] },
  { stop_id: '636', stop_name: 'Astor Pl',                        routes: ['6']                         },
  { stop_id: '637', stop_name: 'Bleecker St',                     routes: ['6']                         },
  { stop_id: '638', stop_name: 'Spring St',                       routes: ['6']                         },
  { stop_id: '639', stop_name: 'Canal St',                        routes: ['4', '5', '6']               },
  { stop_id: '640', stop_name: 'Brooklyn Bridge-City Hall',       routes: ['4', '5', '6']               },
  // 4/5 Brooklyn (Eastern Pkwy)
  { stop_id: '418', stop_name: 'Fulton St',                       routes: ['2', '3', '4', '5', 'A', 'C', 'J', 'Z'] },
  { stop_id: '419', stop_name: 'Nevins St',                       routes: ['2', '3', '4', '5']          },
  { stop_id: '420', stop_name: 'Atlantic Av-Barclays Ctr',        routes: ['2', '3', '4', '5', 'B', 'D', 'N', 'Q', 'R'] },
  { stop_id: '423', stop_name: 'Crown Heights-Utica Av',          routes: ['3', '4']                    },
  { stop_id: '425', stop_name: 'Sutter Av-Rutland Rd',            routes: ['4']                         },
  { stop_id: '426', stop_name: 'Saratoga Av',                     routes: ['4']                         },
  { stop_id: '427', stop_name: 'Junius St',                       routes: ['4']                         },
  { stop_id: '428', stop_name: 'Pennsylvania Av',                 routes: ['4']                         },
  { stop_id: '429', stop_name: 'Van Siclen Av',                   routes: ['4']                         },
  { stop_id: '430', stop_name: 'New Lots Av',                     routes: ['4', '5']                    },
  { stop_id: '431', stop_name: 'Flatbush Av-Brooklyn College',    routes: ['2', '5']                    },
  // 6 train Bronx (Pelham Bay Park)
  { stop_id: '601', stop_name: 'Pelham Bay Park',                 routes: ['6']                         },
  { stop_id: '602', stop_name: 'Buhre Av',                        routes: ['6']                         },
  { stop_id: '603', stop_name: 'Middletown Rd',                   routes: ['6']                         },
  { stop_id: '604', stop_name: 'Westchester Sq-E Tremont Av',     routes: ['6']                         },
  { stop_id: '606', stop_name: 'Zerega Av',                       routes: ['6']                         },
  { stop_id: '607', stop_name: 'Castle Hill Av',                  routes: ['6']                         },
  { stop_id: '608', stop_name: 'Parkchester',                     routes: ['6']                         },
  { stop_id: '609', stop_name: 'St Lawrence Av',                  routes: ['6']                         },
  { stop_id: '610', stop_name: 'Morrison Av-Sound View',          routes: ['6']                         },
  { stop_id: '611', stop_name: 'Elder Av',                        routes: ['6']                         },
  { stop_id: '612', stop_name: 'Whitlock Av',                     routes: ['6']                         },
  { stop_id: '613', stop_name: 'Hunts Point Av',                  routes: ['6']                         },
  { stop_id: '614', stop_name: 'Longwood Av',                     routes: ['6']                         },
  { stop_id: '615', stop_name: 'E 149 St',                        routes: ['6']                         },
  { stop_id: '616', stop_name: 'E 143 St-St Mary\'s St',          routes: ['6']                         },
  { stop_id: '617', stop_name: 'Cypress Av',                      routes: ['6']                         },
  { stop_id: '618', stop_name: 'E 138 St-Grand Concourse',        routes: ['4', '5', '6']               },
  { stop_id: '619', stop_name: 'Brook Av',                        routes: ['6']                         },
  { stop_id: '620', stop_name: '3 Av-138 St',                     routes: ['6']                         },
];

// J/Z lines — BMT Nassau St
const JZ_LINE_STATIONS = [
  { stop_id: 'J12', stop_name: 'Jamaica Center-Parsons/Archer',   routes: ['E', 'J', 'Z']               },
  { stop_id: 'J13', stop_name: 'Sutphin Blvd-Archer Av-JFK',      routes: ['E', 'J', 'Z']               },
  { stop_id: 'J14', stop_name: 'Jamaica-Van Wyck',                routes: ['J']                         },
  { stop_id: 'J15', stop_name: '121 St',                          routes: ['J', 'Z']                    },
  { stop_id: 'J16', stop_name: '111 St',                          routes: ['J', 'Z']                    },
  { stop_id: 'J17', stop_name: '104 St',                          routes: ['J', 'Z']                    },
  { stop_id: 'J19', stop_name: 'Woodhaven Blvd',                  routes: ['J', 'Z']                    },
  { stop_id: 'J20', stop_name: '85 St-Forest Pkwy',               routes: ['J', 'Z']                    },
  { stop_id: 'J21', stop_name: '75 St-Elderts Ln',                routes: ['J', 'Z']                    },
  { stop_id: 'J22', stop_name: 'Broadway Junction',               routes: ['A', 'C', 'J', 'Z', 'L']    },
  { stop_id: 'J23', stop_name: 'Chauncey St',                     routes: ['J', 'Z']                    },
  { stop_id: 'J24', stop_name: 'Halsey St',                       routes: ['J', 'Z']                    },
  { stop_id: 'J25', stop_name: 'Gates Av',                        routes: ['J', 'Z']                    },
  { stop_id: 'J26', stop_name: 'Kosciuszko St',                   routes: ['J']                         },
  { stop_id: 'J27', stop_name: 'Myrtle Av',                       routes: ['J', 'M', 'Z']               },
  { stop_id: 'J28', stop_name: 'Flushing Av',                     routes: ['J', 'M', 'Z']               },
  { stop_id: 'J29', stop_name: 'Lorimer St',                      routes: ['J', 'M', 'Z']               },
  { stop_id: 'J30', stop_name: 'Hewes St',                        routes: ['J', 'M', 'Z']               },
  { stop_id: 'J31', stop_name: 'Marcy Av',                        routes: ['J', 'M', 'Z']               },
  { stop_id: 'M18', stop_name: 'Delancey St-Essex St',            routes: ['F', 'J', 'M', 'Z']          },
  { stop_id: 'M19', stop_name: 'Bowery',                          routes: ['J', 'Z']                    },
  { stop_id: 'M20', stop_name: 'Canal St',                        routes: ['J', 'N', 'Q', 'R', 'W', 'Z'] },
  { stop_id: 'M21', stop_name: 'Chambers St',                     routes: ['J', 'Z']                    },
  { stop_id: 'M22', stop_name: 'Fulton St',                       routes: ['A', 'C', 'J', 'Z', '2', '3', '4', '5'] },
  { stop_id: 'M23', stop_name: 'Broad St',                        routes: ['J', 'Z']                    },
];

// ─── STATIONS lookup (keyed by stop_id) ───────────────────────────────────────
const LINE_CONFIGS = [
  { stations: G_LINE_STATIONS,    feed_group: 'G',       line_group: 'G',    northDest: 'Court Sq',              southDest: 'Church Av'               },
  { stations: L_LINE_STATIONS,    feed_group: 'L',       line_group: 'L',    northDest: '8 Av',                  southDest: 'Canarsie-Rockaway Pkwy'  },
  { stations: SEVEN_LINE_STATIONS,feed_group: '7',       line_group: '7',    northDest: 'Hudson Yards',          southDest: 'Flushing-Main St'        },
  { stations: ACE_LINE_STATIONS,  feed_group: 'ACE',     line_group: 'ACE',  northDest: 'Uptown',                southDest: 'Brooklyn / Queens'       },
  { stations: BDFM_LINE_STATIONS, feed_group: 'BDFM',    line_group: 'BDFM', northDest: 'Uptown & The Bronx',    southDest: 'Brooklyn'                },
  { stations: NQRW_LINE_STATIONS, feed_group: 'NQRW',    line_group: 'NQRW', northDest: 'Queens / Uptown',       southDest: 'Brooklyn'                },
  { stations: LINE_123_STATIONS,  feed_group: '123456S', line_group: '123',  northDest: 'Uptown & The Bronx',    southDest: 'Downtown & Brooklyn'     },
  { stations: LINE_456_STATIONS,  feed_group: '123456S', line_group: '456',  northDest: 'Uptown & The Bronx',    southDest: 'Downtown & Brooklyn'     },
  { stations: JZ_LINE_STATIONS,   feed_group: 'JZ',      line_group: 'JZ',   northDest: 'Jamaica Center',        southDest: 'Broad St'                },
];

const STATIONS = {};
LINE_CONFIGS.forEach(({ stations, feed_group, line_group, northDest, southDest }) => {
  stations.forEach(s => {
    // First writer wins — avoids duplicate stop_ids across groups clobbering each other
    if (!STATIONS[s.stop_id]) {
      STATIONS[s.stop_id] = { ...s, feed_group, line_group, northDest, southDest };
    }
  });
});

// ─── In-memory fallback cache ─────────────────────────────────────────────────
const lastGoodData = {};

// ─── GTFS helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch and decode a GTFS-RT protobuf feed.
 * Uses native fetch (Node 18+) with a 10-second abort timeout.
 */
async function fetchGTFS(feedGroup = 'G') {
  const url = GTFS_FEEDS[feedGroup];
  if (!url) throw new Error(`Unknown feed group: ${feedGroup}`);

  const headers = {};
  if (MTA_API_KEY) headers['x-api-key'] = MTA_API_KEY;

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10000);

  try {
    console.log(`[FETCH] ${feedGroup} feed at ${new Date().toLocaleTimeString()}`);
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
    console.log(`[FETCH] Got ${feed.entity?.length || 0} entities`);
    return feed;
  } catch (err) {
    console.error(`[FETCH] Error:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Return the soonest upcoming train at a given stop/direction,
 * or null if none found.
 */
function getNextTrain(feed, stationId, direction) {
  if (!feed?.entity) return null;

  const stopId  = stationId + direction;
  const now     = Math.floor(Date.now() / 1000);
  let nextTrain = null;
  let minTime   = Infinity;

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    for (const stop of entity.tripUpdate.stopTimeUpdate || []) {
      if (stop.stopId === stopId) {
        const time = stop.arrival?.time || stop.departure?.time;
        if (time && time > now && time < minTime) {
          minTime   = time;
          nextTrain = {
            route:   entity.tripUpdate.trip.routeId || 'G',
            minutes: Math.max(0, Math.round((time - now) / 60)),
          };
        }
      }
    }
  }

  return nextTrain;
}

// ─── MTA routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/next/:stationId
 * Returns next northbound + southbound train for a station.
 * Falls back to last known good data if MTA feed is empty.
 */
app.get('/api/next/:stationId', async (req, res) => {
  const { stationId } = req.params;
  const station = STATIONS[stationId];
  if (!station) return res.status(404).json({ error: 'Unknown station' });

  try {
    const feed = await fetchGTFS(station.feed_group);

    if (feed?.entity?.length) {
      const northTrain = getNextTrain(feed, stationId, 'N');
      const southTrain = getNextTrain(feed, stationId, 'S');

      const data = {
        station: station.stop_name,
        north:   northTrain ? { dest: station.northDest, minutes: northTrain.minutes, route: northTrain.route } : null,
        south:   southTrain ? { dest: station.southDest, minutes: southTrain.minutes, route: southTrain.route } : null,
        time:    new Date().toISOString(),
      };

      lastGoodData[stationId] = data;
      console.log(`[API] ${stationId}: N=${northTrain?.minutes ?? '--'}min  S=${southTrain?.minutes ?? '--'}min`);
      return res.json(data);
    }

    console.log('[API] MTA returned empty — using last known data');
    return res.json(lastGoodData[stationId] || {
      station: station.stop_name,
      north: null,
      south: null,
      time:  new Date().toISOString(),
    });

  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: 'Service unavailable', north: null, south: null });
  }
});

/**
 * GET /api/stations
 * Returns the full list of known stations.
 */
app.get('/api/stations', (req, res) => {
  // Return every station in its canonical line group (LINE_CONFIGS order),
  // so the UI dropdown can filter by line without losing shared stations.
  const all = [];
  LINE_CONFIGS.forEach(({ stations, line_group }) => {
    stations.forEach(s => all.push({ stop_id: s.stop_id, stop_name: s.stop_name, routes: s.routes, line_group }));
  });
  res.json(all);
});

/**
 * GET /api/time
 * Returns current server time for device clock sync.
 */
app.get('/api/time', (req, res) => {
  res.json({ timestamp: Math.floor(Date.now() / 1000), iso: new Date().toISOString() });
});

// ─── Device config routes ─────────────────────────────────────────────────────

/**
 * POST /api/device/:mac/register
 *
 * Called by the device after AP-mode setup completes.
 * Creates a Firestore doc with defaults if this MAC hasn't been seen before.
 * MAC should be lowercase with colons (e.g. aa:bb:cc:dd:ee:ff).
 *
 * Optional body fields: { station_id, display_name }
 *
 * Returns: { registered: bool, config: {...} }
 */
app.post('/api/device/:mac/register', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  try {
    const doc = await docRef.get();

    if (!doc.exists) {
      const defaults = {
        station_id:          req.body.station_id   || 'G26',
        display_name:        req.body.display_name || `Device ${mac.slice(-5)}`,
        modules:             ['mta_subway'],
        brightness:          0.4,   // 0.0–1.0 float for MatrixPortal
        scroll_speed:        10,    // seconds per view panel
        openweather_api_key: '',    // set via Firestore console or admin UI
        zip_code:            '11222',
        registered_at:       admin.firestore.FieldValue.serverTimestamp(),
        last_seen:           admin.firestore.FieldValue.serverTimestamp(),
      };
      await docRef.set(defaults);
      console.log(`[DEVICE] Registered new device: ${mac}`);
      return res.status(201).json({ registered: true, config: defaults });
    }

    await docRef.update({ last_seen: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`[DEVICE] Re-registered existing device: ${mac}`);
    return res.json({ registered: false, config: doc.data() });

  } catch (err) {
    console.error('[DEVICE] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * GET /api/device/:mac/config
 *
 * Called by the device on every boot to fetch its saved configuration.
 * Returns 404 if the device hasn't registered yet.
 * Also bumps last_seen on every call.
 */
app.get('/api/device/:mac/config', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  try {
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Device not registered' });

    await docRef.update({ last_seen: admin.firestore.FieldValue.serverTimestamp() });

    const {
      station_id, display_name, modules,
      brightness, scroll_speed,
      openweather_api_key, zip_code,
    } = doc.data();

    console.log(`[DEVICE] Config fetched: ${mac} → station ${station_id}`);
    res.json({ station_id, display_name, modules, brightness, scroll_speed, openweather_api_key, zip_code });

  } catch (err) {
    console.error('[DEVICE] Config error:', err.message);
    res.status(500).json({ error: 'Could not fetch config' });
  }
});

/**
 * GET /api/devices
 * Returns all registered devices sorted by last_seen (for the admin UI).
 */
app.get('/api/devices', async (req, res) => {
  try {
    const snapshot = await db.collection('devices').orderBy('last_seen', 'desc').get();
    const devices  = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      devices.push({
        mac:                 doc.id,
        display_name:        d.display_name,
        station_id:          d.station_id,
        brightness:          d.brightness,
        scroll_speed:        d.scroll_speed,
        openweather_api_key: d.openweather_api_key,
        zip_code:            d.zip_code,
        modules:             d.modules,
        last_seen:     d.last_seen?.toDate?.()?.toISOString() ?? null,
        registered_at: d.registered_at?.toDate?.()?.toISOString() ?? null,
      });
    });
    res.json(devices);
  } catch (err) {
    console.error('[ADMIN] List devices error:', err.message);
    res.status(500).json({ error: 'Could not list devices' });
  }
});

/**
 * PATCH /api/device/:mac/config
 * Update one or more config fields for a device (admin UI save).
 * Only whitelisted fields are accepted — internal fields cannot be touched.
 */
app.patch('/api/device/:mac/config', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  const ALLOWED = ['display_name', 'station_id', 'brightness', 'scroll_speed', 'openweather_api_key', 'zip_code'];
  const updates = {};
  for (const key of ALLOWED) {
    if (key in req.body) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Device not found' });

    await docRef.update(updates);
    console.log(`[ADMIN] Updated ${mac}: ${Object.keys(updates).join(', ')}`);
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) {
    console.error('[ADMIN] Update error:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── Firmware generator ───────────────────────────────────────────────────────

/**
 * GET /firmware/:mac
 *
 * Returns a generated code.py tailored to this device's Firestore config.
 * The device can fetch this on boot and write it to CIRCUITPY if the
 * content hash has changed (self-update flow).
 */
app.get('/firmware/:mac', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  try {
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Device not registered' });

    const config   = doc.data();
    const firmware = generateFirmware(config, mac);

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="code.py"');
    console.log(`[FIRMWARE] Served to ${mac} (station: ${config.station_id})`);
    res.send(firmware);

  } catch (err) {
    console.error('[FIRMWARE] Error:', err.message);
    res.status(500).json({ error: 'Could not generate firmware' });
  }
});

/**
 * Assemble a complete code.py from device config.
 *
 * All device-specific constants (SERVER_URL, BRIGHTNESS, VIEW_CYCLE_INTERVAL,
 * and the CFG dict containing station_id, weather_api_key, zip_code) are injected at the top.
 * The device's secrets.py only needs to contain ssid + password.
 */
function generateFirmware(config, mac) {
  return `"""
MTA LED Sign - 64x32 Single Panel
Auto-generated by subway-sign server — do not edit manually.
Device : ${mac}
Station: ${config.station_id} (${config.display_name})
Built  : ${new Date().toISOString()}
"""

import time
import board
import displayio
import gc
from adafruit_matrixportal.matrixportal import MatrixPortal
from adafruit_display_text import label
from adafruit_bitmap_font import bitmap_font

try:
    from adafruit_display_shapes.circle import Circle
    has_shapes = True
except ImportError:
    has_shapes = False

# ── WiFi credentials (written to device by AP setup mode) ─────────────────────
from secrets import secrets  # needs: ssid, password only

# ── Device config (injected by server at firmware generation time) ─────────────
SERVER_URL          = "${SERVICE_URL}"
BRIGHTNESS          = ${config.brightness}
VIEW_CYCLE_INTERVAL = ${config.scroll_speed}   # seconds per view panel
CFG = {
    "station_id":      "${config.station_id}",
    "weather_api_key": "${config.openweather_api_key}",
    "zip_code":        "${config.zip_code}",
}

print("MTA Sign - 64x32")
print("=" * 40)

# ── Display dimensions ─────────────────────────────────────────────────────────
MATRIX_WIDTH  = 64
MATRIX_HEIGHT = 32

# ── Update intervals ───────────────────────────────────────────────────────────
UPDATE_INTERVAL          = 30    # seconds between train fetches
WEATHER_UPDATE_INTERVAL  = 600   # 10 minutes
FORECAST_UPDATE_INTERVAL = 1800  # 30 minutes
MAX_RETRIES = 3
RETRY_DELAY = 5   # seconds between WiFi retries

# ── Colors ─────────────────────────────────────────────────────────────────────
BLACK    = 0x000000
WHITE    = 0xFFFFFF
GREEN    = 0x0000FF
ORANGE   = 0xFF00AA
YELLOW   = 0xFF00AA
RED      = 0xEE352E
MTA_BLUE = 0x39A600

# ── Initialize display ─────────────────────────────────────────────────────────
matrixportal = MatrixPortal(width=MATRIX_WIDTH, height=MATRIX_HEIGHT, bit_depth=4)
matrixportal.display.brightness = BRIGHTNESS

# ── Load font ──────────────────────────────────────────────────────────────────
try:
    font = bitmap_font.load_font("/fonts/tom-thumb.bdf")
    print("Loaded tom-thumb font")
except (OSError, RuntimeError):
    import terminalio
    font = terminalio.FONT
    print("Using terminal font")


class TrainDisplay:
    """Manages the LED matrix display for train arrivals and weather"""

    def __init__(self):
        self.main_group = displayio.Group()
        matrixportal.display.root_group = self.main_group
        self.current_view = "subway"  # "subway", "weather", or "forecast"
        self._setup_display()
        self._setup_splash()
        matrixportal.display.root_group = self.splash_group  # Boot with splash

    def _setup_display(self):
        """Initialize display elements"""
        # ── Subway view ────────────────────────────────────────────────────────
        self.subway_group = displayio.Group()
        self.subway_group.y = 0

        if has_shapes:
            north_bullet = Circle(5, 9, 4, fill=GREEN)
            self.subway_group.append(north_bullet)

        self.north_route = label.Label(font, text="G", color=WHITE, x=4, y=10)
        self.north_dest  = label.Label(font, text="Court Sq", color=WHITE, x=12, y=10)
        self.north_time  = label.Label(font, text="--", color=ORANGE, x=50, y=10)
        self.north_min   = label.Label(font, text="", color=ORANGE, x=60, y=10)

        self.subway_group.append(self.north_route)
        self.subway_group.append(self.north_dest)
        self.subway_group.append(self.north_time)
        self.subway_group.append(self.north_min)

        if has_shapes:
            south_bullet = Circle(5, 22, 4, fill=GREEN)
            self.subway_group.append(south_bullet)

        self.south_route = label.Label(font, text="G", color=WHITE, x=4, y=23)
        self.south_dest  = label.Label(font, text="Church Av", color=WHITE, x=12, y=23)
        self.south_time  = label.Label(font, text="--", color=ORANGE, x=50, y=23)
        self.south_min   = label.Label(font, text="", color=ORANGE, x=60, y=23)

        self.subway_group.append(self.south_route)
        self.subway_group.append(self.south_dest)
        self.subway_group.append(self.south_time)
        self.subway_group.append(self.south_min)

        self.status = label.Label(font, text="", color=WHITE, x=15, y=16)
        self.subway_group.append(self.status)

        self.main_group.append(self.subway_group)

        # ── Weather view ───────────────────────────────────────────────────────
        self.weather_group = displayio.Group()
        self.weather_group.y = MATRIX_HEIGHT

        self.weather_condition = label.Label(font, text="", color=WHITE, x=8, y=10)
        self.weather_group.append(self.weather_condition)

        self.weather_temp = label.Label(font, text="--F", color=ORANGE, x=24, y=18)
        self.weather_group.append(self.weather_temp)

        self.weather_high_label = label.Label(font, text="H:", color=WHITE, x=12, y=26)
        self.weather_high       = label.Label(font, text="--", color=RED, x=20, y=26)
        self.weather_low_label  = label.Label(font, text="L:", color=WHITE, x=36, y=26)
        self.weather_low        = label.Label(font, text="--", color=MTA_BLUE, x=44, y=26)

        self.weather_group.append(self.weather_high_label)
        self.weather_group.append(self.weather_high)
        self.weather_group.append(self.weather_low_label)
        self.weather_group.append(self.weather_low)

        self.main_group.append(self.weather_group)

        # ── Forecast view ──────────────────────────────────────────────────────
        self.forecast_group = displayio.Group()
        self.forecast_group.y = MATRIX_HEIGHT * 2

        self.day1_name = label.Label(font, text="", color=WHITE, x=2, y=9)
        self.day1_high = label.Label(font, text="", color=RED, x=20, y=9)
        self.day1_low  = label.Label(font, text="", color=MTA_BLUE, x=32, y=9)
        self.day1_cond = label.Label(font, text="", color=WHITE, x=44, y=9)

        self.forecast_group.append(self.day1_name)
        self.forecast_group.append(self.day1_high)
        self.forecast_group.append(self.day1_low)
        self.forecast_group.append(self.day1_cond)

        self.day2_name = label.Label(font, text="", color=WHITE, x=2, y=18)
        self.day2_high = label.Label(font, text="", color=RED, x=20, y=18)
        self.day2_low  = label.Label(font, text="", color=MTA_BLUE, x=32, y=18)
        self.day2_cond = label.Label(font, text="", color=WHITE, x=44, y=18)

        self.forecast_group.append(self.day2_name)
        self.forecast_group.append(self.day2_high)
        self.forecast_group.append(self.day2_low)
        self.forecast_group.append(self.day2_cond)

        self.day3_name = label.Label(font, text="", color=WHITE, x=2, y=27)
        self.day3_high = label.Label(font, text="", color=RED, x=20, y=27)
        self.day3_low  = label.Label(font, text="", color=MTA_BLUE, x=32, y=27)
        self.day3_cond = label.Label(font, text="", color=WHITE, x=44, y=27)

        self.forecast_group.append(self.day3_name)
        self.forecast_group.append(self.day3_high)
        self.forecast_group.append(self.day3_low)
        self.forecast_group.append(self.day3_cond)

        self.main_group.append(self.forecast_group)

        # ── Error indicator (corner dot) ───────────────────────────────────────
        if has_shapes:
            error_dot = Circle(61, 2, 1, fill=RED)
            self.error_group = displayio.Group()
            self.error_group.append(error_dot)
            self.error_group.hidden = True
            self.main_group.append(self.error_group)
        else:
            self.error_group = None

    def update_train_time(self, time_label, min_label, minutes, is_south=False):
        """Update train time display with proper positioning"""
        if minutes is None:
            time_label.text = "--"
            time_label.x = 50
            min_label.text = ""
            return

        if minutes == 0:
            time_label.text = "now"
            time_label.x = 50
            min_label.text = ""
            time_label.color = YELLOW
        else:
            time_label.text = str(minutes)
            time_label.x = 50
            min_label.text = "m"
            time_label.color = ORANGE

        min_label.color = ORANGE

    def update(self, data):
        """Update display with train data"""
        if not data:
            return
        self.status.text = ""
        # north/south can be None when no trains are running
        north_minutes = (data.get('north') or {}).get('minutes')
        self.update_train_time(self.north_time, self.north_min, north_minutes)
        south_minutes = (data.get('south') or {}).get('minutes')
        self.update_train_time(self.south_time, self.south_min, south_minutes, is_south=True)

    def show_status(self, message):
        """Show a short status message on the subway view"""
        self.status.text = message[:8]

    def show_error(self, show=True):
        """Show/hide error indicator dot"""
        if self.error_group:
            self.error_group.hidden = not show

    def _setup_splash(self):
        """Initialize boot splash shown during WiFi connect"""
        self.splash_group = displayio.Group()
        if has_shapes:
            self.splash_bullet = Circle(10, 16, 5, fill=GREEN)
            self.splash_group.append(self.splash_bullet)
        self.splash_letter = label.Label(font, text="G", color=WHITE, x=8, y=17)
        self.splash_group.append(self.splash_letter)
        self.splash_line1 = label.Label(font, text="Starting...", color=WHITE, x=20, y=12)
        self.splash_group.append(self.splash_line1)
        self.splash_line2 = label.Label(font, text="", color=ORANGE, x=20, y=21)
        self.splash_group.append(self.splash_line2)

    def show_splash(self, line1="", line2=""):
        """Show boot splash with two status lines"""
        self.splash_line1.text = line1[:10]
        self.splash_line2.text = line2[:10]
        matrixportal.display.root_group = self.splash_group

    def hide_splash(self):
        """Dismiss splash and reveal main display"""
        matrixportal.display.root_group = self.main_group

    def update_weather(self, weather_data):
        """Update weather display"""
        if not weather_data:
            return
        temp      = weather_data.get('temp', '--')
        condition = weather_data.get('condition', '')
        high      = weather_data.get('high', '--')
        low       = weather_data.get('low', '--')

        self.weather_condition.text = condition[:14]
        self.weather_temp.text = f"{temp}F"
        self.weather_high.text = str(high)
        self.weather_low.text  = str(low)

    def update_forecast(self, forecast_data):
        """Update 3-day forecast display"""
        if not forecast_data or len(forecast_data) < 3:
            return

        day1 = forecast_data[0]
        self.day1_name.text = day1.get('day', '')[:3]
        self.day1_high.text = f"H{day1.get('high', '--')}"
        self.day1_low.text  = f"L{day1.get('low', '--')}"
        self.day1_cond.text = day1.get('condition', '')[:8]

        day2 = forecast_data[1]
        self.day2_name.text = day2.get('day', '')[:3]
        self.day2_high.text = f"H{day2.get('high', '--')}"
        self.day2_low.text  = f"L{day2.get('low', '--')}"
        self.day2_cond.text = day2.get('condition', '')[:8]

        day3 = forecast_data[2]
        self.day3_name.text = day3.get('day', '')[:3]
        self.day3_high.text = f"H{day3.get('high', '--')}"
        self.day3_low.text  = f"L{day3.get('low', '--')}"
        self.day3_cond.text = day3.get('condition', '')[:8]

    def scroll_to_view(self, view_name):
        """Animate vertical scroll to specified view"""
        if self.current_view == view_name:
            return

        if view_name == "weather":
            subway_target   = -MATRIX_HEIGHT
            weather_target  = 0
            forecast_target = MATRIX_HEIGHT
        elif view_name == "forecast":
            subway_target   = -MATRIX_HEIGHT * 2
            weather_target  = -MATRIX_HEIGHT
            forecast_target = 0
        else:  # subway
            subway_target   = 0
            weather_target  = MATRIX_HEIGHT
            forecast_target = MATRIX_HEIGHT * 2

        frames = 8
        for i in range(frames + 1):
            progress = i / frames
            self.subway_group.y   = int(self.subway_group.y   + (subway_target   - self.subway_group.y)   * progress)
            self.weather_group.y  = int(self.weather_group.y  + (weather_target  - self.weather_group.y)  * progress)
            self.forecast_group.y = int(self.forecast_group.y + (forecast_target - self.forecast_group.y) * progress)
            time.sleep(0.08)

        self.subway_group.y   = subway_target
        self.weather_group.y  = weather_target
        self.forecast_group.y = forecast_target
        self.current_view = view_name


class NetworkManager:
    """Handles WiFi connection and HTTP requests"""

    def __init__(self):
        self.connected   = False
        self.requests    = None
        self.mac         = None   # set after first successful connect
        self.error_count = 0
        self.last_connect_attempt = 0

    def connect(self):
        """Connect to WiFi using credentials from secrets.py"""
        current_time = time.monotonic()
        if current_time - self.last_connect_attempt < RETRY_DELAY:
            return self.connected
        self.last_connect_attempt = current_time

        try:
            import wifi
            import socketpool
            import ssl
            import adafruit_requests

            print(f"Connecting to {secrets['ssid']}")

            if not wifi.radio.connected:
                wifi.radio.connect(secrets['ssid'], secrets['password'])

            pool = socketpool.SocketPool(wifi.radio)
            self.requests = adafruit_requests.Session(pool, ssl.create_default_context())

            print(f"Connected: {wifi.radio.ipv4_address}")
            if self.mac is None:
                self.mac = ':'.join('{:02x}'.format(b) for b in wifi.radio.mac_address)
                print(f"MAC: {self.mac}")
            self.connected   = True
            self.error_count = 0
            return True

        except Exception as e:
            print(f"WiFi connection error: {e}")
            self.connected = False
            return False

    def fetch_trains(self):
        """Fetch train data from server"""
        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            url = f"{SERVER_URL}/api/next/{CFG['station_id']}"
            print(f"Fetching: {url}")

            response = self.requests.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()
                response.close()
                gc.collect()

                # north/south can be null when no trains are running
                north = data.get('north') or {}
                south = data.get('south') or {}
                n_min = north.get('minutes', '--')
                s_min = south.get('minutes', '--')
                print(f"Received: North={n_min}min, South={s_min}min")

                self.error_count = 0
                return data
            else:
                print(f"HTTP error {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Request error: {e}")
            self.error_count += 1
            if self.error_count >= MAX_RETRIES:
                self.connected = False
                print("Resetting connection after multiple failures")

        return None

    def fetch_weather(self):
        """Fetch current weather from OpenWeatherMap"""
        if not CFG['weather_api_key']:
            print("No weather API key configured")
            return None

        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            url = f"https://api.openweathermap.org/data/2.5/weather?zip={CFG['zip_code']},us&appid={CFG['weather_api_key']}&units=imperial"
            print("Fetching weather...")

            response = self.requests.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()
                response.close()

                temp      = int(data['main']['temp'])
                condition = data['weather'][0]['description'].upper()
                high      = int(data['main']['temp_max'])
                low       = int(data['main']['temp_min'])

                weather_data = {'temp': temp, 'condition': condition, 'high': high, 'low': low}
                print(f"Weather: {temp}F, {condition}")
                gc.collect()
                return weather_data
            else:
                print(f"Weather API error {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Weather fetch error: {e}")

        return None

    def fetch_forecast(self):
        """Fetch 3-day forecast from OpenWeatherMap"""
        if not CFG['weather_api_key']:
            print("No weather API key configured")
            return None

        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            url = f"https://api.openweathermap.org/data/2.5/forecast?zip={CFG['zip_code']},us&appid={CFG['weather_api_key']}&units=imperial"
            print("Fetching forecast...")

            response = self.requests.get(url, timeout=15)

            if response.status_code == 200:
                data = response.json()
                response.close()

                forecast_list = data.get('list', [])
                if not forecast_list:
                    return None

                # Group forecast entries by calendar day
                days = {}
                for item in forecast_list:
                    dt_txt   = item.get('dt_txt', '')
                    date_str = dt_txt.split(' ')[0]
                    if not date_str:
                        continue
                    if date_str not in days:
                        days[date_str] = {'temps': [], 'conditions': []}
                    days[date_str]['temps'].append(item['main']['temp'])
                    days[date_str]['conditions'].append(item['weather'][0]['main'])

                # Build forecast for the next 3 days (skip today)
                day_names     = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                sorted_days   = sorted(days.keys())
                forecast_data = []

                for date_str in sorted_days[1:4]:
                    day_data   = days[date_str]
                    high       = int(max(day_data['temps']))
                    low        = int(min(day_data['temps']))
                    conditions = day_data['conditions']
                    condition  = max(set(conditions), key=conditions.count) if conditions else 'Clear'

                    # Zeller's congruence to get day-of-week name
                    parts = date_str.split('-')
                    year  = int(parts[0])
                    month = int(parts[1])
                    day   = int(parts[2])
                    if month < 3:
                        month += 12
                        year  -= 1
                    day_of_week = (day + ((13 * (month + 1)) // 5) + year + (year // 4) - (year // 100) + (year // 400)) % 7
                    day_index   = (day_of_week + 5) % 7
                    day_name    = day_names[day_index]

                    forecast_data.append({'day': day_name, 'high': high, 'low': low, 'condition': condition})

                print(f"Forecast: {len(forecast_data)} days")
                gc.collect()
                return forecast_data if len(forecast_data) >= 3 else None

            else:
                print(f"Forecast API error {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Forecast fetch error: {e}")

        return None

    def register_and_fetch_config(self):
        """Register this device with the server and return its Firestore config.

        Creates the Firestore document on first run; bumps last_seen on every
        subsequent boot.  Returns a config dict or None on any failure.
        """
        if not self.connected or not self.requests:
            if not self.connect():
                return None
        if not self.mac:
            return None

        try:
            # Register (idempotent — safe to call on every boot)
            reg_url = f"{SERVER_URL}/api/device/{self.mac}/register"
            print(f"Registering device {self.mac}...")
            resp = self.requests.post(reg_url, timeout=10)
            resp.close()
            gc.collect()

            # Fetch config
            cfg_url = f"{SERVER_URL}/api/device/{self.mac}/config"
            resp = self.requests.get(cfg_url, timeout=10)
            if resp.status_code == 200:
                config = resp.json()
                resp.close()
                gc.collect()
                print(f"Config: station={config.get('station_id')} brightness={config.get('brightness')}")
                return config
            else:
                print(f"Config fetch failed: HTTP {resp.status_code}")
                resp.close()

        except Exception as e:
            print(f"Registration error: {e}")

        return None


# ── Initialize components ──────────────────────────────────────────────────────
display = TrainDisplay()
network = NetworkManager()

print("Display initialized")
print("\\nStarting main program...")

# ── Initial WiFi connection (3 attempts) ───────────────────────────────────────
weather_data  = None
forecast_data = None
connected     = False

for attempt in range(3):
    display.show_splash("Connecting", "WiFi {}/3".format(attempt + 1))
    print("WiFi attempt {}/3".format(attempt + 1))
    if network.connect():
        connected = True
        break
    if attempt < 2:
        time.sleep(RETRY_DELAY)

if connected:
    display.show_splash("Connected!", "Syncing...")

    # Register with server and pull Firestore config.
    # Returned values override the compiled-in defaults above.
    config = network.register_and_fetch_config()
    if config:
        CFG['station_id']      = config.get('station_id', CFG['station_id'])
        CFG['weather_api_key'] = config.get('openweather_api_key', CFG['weather_api_key'])
        CFG['zip_code']        = config.get('zip_code', CFG['zip_code'])
        VIEW_CYCLE_INTERVAL    = config.get('scroll_speed', VIEW_CYCLE_INTERVAL)
        BRIGHTNESS             = config.get('brightness', BRIGHTNESS)
        matrixportal.display.brightness = BRIGHTNESS
        print("Firestore config applied")

    display.show_splash("Connected!", "Loading...")
    time.sleep(1)

    initial_data = network.fetch_trains()
    if initial_data:
        display.update(initial_data)
        display.show_error(False)
    else:
        display.show_error(True)

    weather_data = network.fetch_weather()
    if weather_data:
        display.update_weather(weather_data)

    forecast_data = network.fetch_forecast()
    if forecast_data:
        display.update_forecast(forecast_data)

    display.hide_splash()
else:
    # All retries failed — launch AP captive portal for WiFi setup
    print("WiFi failed after 3 attempts — entering AP setup mode")
    import setup_mode
    setup_mode.run(display)
    # setup_mode.run() never returns — calls microcontroller.reset()

# ── Main loop ──────────────────────────────────────────────────────────────────
last_update          = time.monotonic()
last_weather_update  = time.monotonic()
last_forecast_update = time.monotonic()
last_view_cycle      = time.monotonic()
current_view_index   = 0  # 0=subway, 1=weather, 2=forecast
views = ["subway", "weather", "forecast"]

print(f"Main loop — view cycles every {VIEW_CYCLE_INTERVAL}s")

while True:
    current_time = time.monotonic()

    # Train update
    if current_time - last_update >= UPDATE_INTERVAL:
        train_data = network.fetch_trains()
        if train_data:
            display.update(train_data)
            display.show_error(False)
        else:
            display.show_error(True)
        last_update = current_time
        gc.collect()
        print(f"Free memory: {gc.mem_free()} bytes")

    # Weather update
    if current_time - last_weather_update >= WEATHER_UPDATE_INTERVAL:
        weather_data = network.fetch_weather()
        if weather_data:
            display.update_weather(weather_data)
        last_weather_update = current_time
        gc.collect()

    # Forecast update
    if current_time - last_forecast_update >= FORECAST_UPDATE_INTERVAL:
        forecast_data = network.fetch_forecast()
        if forecast_data:
            display.update_forecast(forecast_data)
        last_forecast_update = current_time
        gc.collect()

    # View cycling
    if current_time - last_view_cycle >= VIEW_CYCLE_INTERVAL:
        current_view_index = (current_view_index + 1) % len(views)
        display.scroll_to_view(views[current_view_index])
        last_view_cycle = current_time

    time.sleep(0.2)
`;
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚇 Subway Sign Server`);
  console.log(`📡 Port       : ${PORT}`);
  console.log(`🔑 MTA Key    : ${MTA_API_KEY ? 'yes' : 'no'}`);
  console.log(`🌐 Service URL: ${SERVICE_URL}`);
  console.log(`🗄️  Firestore  : ${admin.app().options.projectId || '(project from ADC)'}`);
});
