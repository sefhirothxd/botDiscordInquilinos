require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const cron = require('node-cron');
const { Pool } = require('pg');
const moment = require('moment-timezone');

// Configuración del bot de Discord
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

// Token del bot y ID del canal desde variables de entorno
const token = process.env.DISCORD_TOKEN;
const canalId = process.env.CANAL_ID;

// Configuración de PostgreSQL
const pool = new Pool({
	connectionString: process.env.DATABASE_URL, // URL de conexión a PostgreSQL
	ssl: {
		rejectUnauthorized: false, // Necesario para conexiones SSL en Railway
	},
});

// Crear la tabla de inquilinos si no existe
async function crearTabla() {
	try {
		await pool.query(`
            CREATE TABLE IF NOT EXISTS inquilinos (
                id SERIAL PRIMARY KEY,
                nombre TEXT NOT NULL,
                fecha_ingreso DATE NOT NULL,
                diaPago INTEGER NOT NULL,
                numero_cuarto INTEGER NOT NULL UNIQUE
            )
        `);
		console.log('Tabla de inquilinos creada o ya existente.');
	} catch (err) {
		console.error('Error al crear la tabla:', err);
	}
}

// Función para verificar si un cuarto ya está ocupado
async function cuartoOcupado(numeroCuarto) {
	try {
		const res = await pool.query(
			'SELECT * FROM inquilinos WHERE numero_cuarto = $1',
			[numeroCuarto]
		);
		return res.rows.length > 0;
	} catch (err) {
		console.error('Error al verificar el cuarto:', err);
		return true; // Suponemos que hay un error y evitamos agregar el inquilino
	}
}

// Función para agregar un inquilino
client.on('messageCreate', async (message) => {
	if (message.content.startsWith('!agregar-inquilino')) {
		const args = message.content.split(' ');
		const nombre = args[1];
		const fechaIngreso = args[2]; // Formato: DD/MM
		const numeroCuarto = parseInt(args[3]);

		if (nombre && fechaIngreso && numeroCuarto) {
			try {
				// Verificar si el cuarto ya está ocupado
				if (await cuartoOcupado(numeroCuarto)) {
					message.reply(`El cuarto ${numeroCuarto} ya está ocupado.`);
					return;
				}

				// Convertir la fecha de ingreso a formato DATE (YYYY-MM-DD) en la zona horaria de Perú
				const [dia, mes] = fechaIngreso.split('/');
				const fechaIngresoDate = moment
					.tz(`${dia}/${mes}/2023`, 'DD/MM/YYYY', 'America/Lima')
					.toDate();

				// Extraer el día de pago (día de la fecha de ingreso)
				const diaPago = fechaIngresoDate.getDate();

				// Insertar el nuevo inquilino en la base de datos
				await pool.query(
					'INSERT INTO inquilinos (nombre, fecha_ingreso, diaPago, numero_cuarto) VALUES ($1, $2, $3, $4)',
					[nombre, fechaIngresoDate, diaPago, numeroCuarto]
				);
				message.reply(
					`Inquilino ${nombre} agregado con fecha de ingreso ${fechaIngreso}, día de pago el ${diaPago} y número de cuarto ${numeroCuarto}.`
				);
			} catch (err) {
				console.error('Error al agregar el inquilino:', err);
				message.reply('Error al agregar el inquilino.');
			}
		} else {
			message.reply(
				`Formato incorrecto. Usa: !agregar-inquilino <nombre> <fecha_ingreso> <número de cuarto>`
			);
		}
	}
});
// Función para eliminar un inquilino
client.on('messageCreate', async (message) => {
	if (message.content.startsWith('!eliminar-inquilino')) {
		const args = message.content.split(' ');
		const numeroCuarto = parseInt(args[1]);

		if (numeroCuarto) {
			try {
				// Eliminar el inquilino de la base de datos
				const res = await pool.query(
					'DELETE FROM inquilinos WHERE numero_cuarto = $1 RETURNING *',
					[numeroCuarto]
				);

				if (res.rows.length > 0) {
					message.reply(
						`Inquilino del cuarto ${numeroCuarto} eliminado correctamente.`
					);
				} else {
					message.reply(
						`No se encontró un inquilino en el cuarto ${numeroCuarto}.`
					);
				}
			} catch (err) {
				console.error('Error al eliminar el inquilino:', err);
				message.reply('Error al eliminar el inquilino.');
			}
		} else {
			message.reply(
				`Formato incorrecto. Usa: !eliminar-inquilino <número de cuarto>`
			);
		}
	}
});

// Función para obtener los inquilinos desde la base de datos
async function obtenerInquilinos() {
	try {
		const res = await pool.query('SELECT * FROM inquilinos');
		return res.rows;
	} catch (err) {
		console.error('Error al obtener los inquilinos:', err);
		return [];
	}
}

// Función para ver la lista de inquilinos
client.on('messageCreate', async (message) => {
	if (message.content.startsWith('!ver-inquilinos')) {
		const inquilinos = await obtenerInquilinos();
		if (inquilinos.length > 0) {
			let lista = '**Lista de inquilinos:**\n';
			inquilinos.forEach((inquilino) => {
				let formatDate = new Date(inquilino.fecha_ingreso).toLocaleDateString(
					'es-CO',
					{ year: 'numeric', month: 'long', day: 'numeric' }
				);
				lista += `- ${inquilino.nombre} (Cuarto ${inquilino.numero_cuarto}), día de pago: ${inquilino.diapago} , fecha de ingreso: ${formatDate}  \n`;
			});

			message.reply(lista);
		} else {
			message.reply('No hay inquilinos registrados.');
		}
	}
});

// Función para enviar recordatorios según el día de pago de cada inquilino
async function enviarRecordatorios() {
	const hoy = new Date();
	const diaActual = hoy.getDate();

	const inquilinos = await obtenerInquilinos();
	const canal = client.channels.cache.get(canalId);

	if (canal) {
		inquilinos.forEach((inquilino) => {
			if (diaActual === parseInt(inquilino.diapago)) {
				canal.send(
					`📅 Recordatorio: Hoy es el día de pago de ${inquilino.nombre} (Cuarto ${inquilino.numero_cuarto}).`
				);
			}
		});
	} else {
		console.error('No se encontró el canal con el ID proporcionado.');
	}
}

// Evento cuando el bot está listo
client.once('ready', async () => {
	console.log(`Bot ${client.user.tag} está listo!`);

	// Crear la tabla si no existe
	await crearTabla();

	// Programar la verificación diaria a las 9:00 AM
	cron.schedule(
		'0 9 * * *',
		async () => {
			await enviarRecordatorios();
		},
		{
			timezone: 'America/Bogota', // Cambia la zona horaria según tu ubicación
		}
	);
});

// Iniciar el bot
client.login(token);
