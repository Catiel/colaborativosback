export default function handler(req, res) {
  const equipoInfo = {
    nombre: 'WARASOFT',
    integrantes: [
      'Mildred',
      'Ara',
      'Andy',
      'Derick',
      'Oliver',
      'Patricia',
      'Nahuel'
    ]
  };

  res.status(200).json(equipoInfo);
} 